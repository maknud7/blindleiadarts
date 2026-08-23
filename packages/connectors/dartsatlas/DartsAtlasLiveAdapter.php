<?php

declare(strict_types=1);

require_once __DIR__ . '/DartsAtlasHttpClient.php';
require_once __DIR__ . '/DartsAtlasParser.php';
require_once __DIR__ . '/BlindleiaMemberDirectory.php';
require_once __DIR__ . '/DartsAtlasStore.php';
require_once __DIR__ . '/BlindleiaPlayerIdentityResolver.php';

final class DartsAtlasLiveAdapter
{
    private int $clubId;
    private DartsAtlasStore $store;
    private BlindleiaPlayerIdentityResolver $identity;

    public function __construct(
        mysqli $db,
        string $tablePrefix,
        private DartsAtlasHttpClient $http,
        private DartsAtlasParser $parser,
        BlindleiaMemberDirectory $members,
        string $clubName='Blindleia Dartklubb',
        string $clubSlug='blindleia-dartklubb'
    ) {
        $this->store=new DartsAtlasStore($db,$tablePrefix);
        $this->clubId=$this->store->ensureClub($clubName,$clubSlug);
        $this->identity=new BlindleiaPlayerIdentityResolver($this->store,$members,$this->clubId);
    }

    public function clubId(): int { return $this->clubId; }
    public function linkPlayerToMember(int $playerId,int $memberId): void { $this->identity->manuallyLink($playerId,$memberId); }

    /** @return array{source_url:string,tournament_ids:list<string>} */
    public function discover(string $sourceUrl): array
    {
        $response=$this->http->get($sourceUrl);
        return ['source_url'=>$response['url'],'tournament_ids'=>$this->parser->extractTournamentIds($response['body'])];
    }

    /** @return array<string,mixed> */
    public function syncTournament(string $externalTournamentId,?string $externalSeasonId=null): array
    {
        $jobId=$this->store->startJob('sync_tournament');
        try{
            $docs=$this->tournamentDocuments($externalTournamentId); $main=$docs['main']['body'];
            $title=$this->parser->extractTitle($main)??('Darts Atlas tournament '.$externalTournamentId);
            if($externalSeasonId===null||$externalSeasonId===''){
                $seasonIds=$this->parser->extractSeasonIds($main); if(count($seasonIds)===1)$externalSeasonId=$seasonIds[0];
            }
            $seasonId=$this->resolveSeason($externalSeasonId);
            $metadata=['external_id'=>$externalTournamentId,'external_season_id'=>$externalSeasonId,'source_urls'=>array_map(static fn(array $d):string=>(string)$d['url'],$docs),'synced_at'=>(new DateTimeImmutable())->format(DateTimeInterface::ATOM)];
            $tournamentId=$this->store->upsertTournament($this->clubId,$seasonId,$externalTournamentId,$title,$this->parser->extractTournamentStartAt($main),$metadata);
            $this->store->scopeJob($jobId,$tournamentId);

            $matchIds=[]; foreach($docs as $doc)$matchIds=array_merge($matchIds,$this->parser->extractMatchIds($doc['body']));
            $matchIds=array_values(array_unique($matchIds)); sort($matchIds);
            $synced=0; $skipped=0; $warnings=[];
            foreach($matchIds as $externalMatchId){
                $result=$this->syncMatch($tournamentId,$externalMatchId); $result['synced']?$synced++:$skipped++;
                $warnings=array_merge($warnings,$result['identity_warnings']);
            }
            $status=$this->tournamentStatus($main,$synced); $this->store->updateTournamentStatus($tournamentId,$status);
            $summary=['external_tournament_id'=>$externalTournamentId,'tournament_id'=>$tournamentId,'title'=>$title,'status'=>$status,'match_ids_found'=>count($matchIds),'matches_synced'=>$synced,'matches_skipped'=>$skipped,'identity_warnings'=>array_values(array_unique($warnings))];
            $this->store->finishJob($jobId,'completed',$summary); return $summary;
        }catch(Throwable $e){ $this->store->finishJob($jobId,'failed',[],$e->getMessage()); throw $e; }
    }

    /** @return array<string,mixed> */
    public function liveState(): array { return $this->store->liveState($this->clubId); }

    /** @return array{synced:bool,identity_warnings:list<string>} */
    private function syncMatch(int $tournamentId,string $externalMatchId): array
    {
        $base=$this->http->get("/matches/{$externalMatchId}",true);
        if($base['body']==='') return ['synced'=>false,'identity_warnings'=>["match:{$externalMatchId}:base_unavailable"]];
        $players=$this->parser->extractPlayers($base['body']);
        if(count($players)<2) return ['synced'=>false,'identity_warnings'=>["match:{$externalMatchId}:players_not_parsed"]];
        $players=array_slice($players,0,2); $a=$this->identity->resolve($players[0]); $b=$this->identity->resolve($players[1]);
        $warnings=[]; if($a['link_state']!=='linked')$warnings[]="match:{$externalMatchId}:player_A:{$a['link_state']}"; if($b['link_state']!=='linked')$warnings[]="match:{$externalMatchId}:player_B:{$b['link_state']}";
        $stats=$this->http->get("/matches/{$externalMatchId}/broadcast?mode=dual_cam_stats",true);
        $summary=$this->http->get("/matches/{$externalMatchId}/broadcast_summary",true);
        $snapshot=$this->parser->extractLiveSnapshot($base['body'],$stats['body'],$summary['body']);
        $matchId=$this->store->upsertMatch($tournamentId,$externalMatchId,$a['player_id'],$b['player_id'],$snapshot['status']);
        $this->store->upsertLiveState($matchId,$externalMatchId,$snapshot);
        return ['synced'=>true,'identity_warnings'=>$warnings];
    }

    private function resolveSeason(?string $externalSeasonId): ?int
    {
        if($externalSeasonId===null||$externalSeasonId==='')return null;
        $existing=$this->store->reference('dartsatlas','season',$externalSeasonId,'season'); if($existing!==null)return $existing;
        $response=$this->http->get("/seasons/{$externalSeasonId}",true);
        $name=$response['body']===''?'Darts Atlas season '.$externalSeasonId:($this->parser->extractTitle($response['body'])??'Darts Atlas season '.$externalSeasonId);
        return $this->store->ensureSeason($this->clubId,$externalSeasonId,$name);
    }

    /** @return array<string,array{url:string,status:int,body:string,etag:?string,last_modified:?string}> */
    private function tournamentDocuments(string $id): array
    {
        $routes=['main'=>"/tournaments/{$id}",'results'=>"/tournaments/{$id}/results",'groups'=>"/tournaments/{$id}/groups",'bracket'=>"/tournaments/{$id}/bracket"];
        $docs=[]; foreach($routes as $key=>$route)$docs[$key]=$this->http->get($route,$key!=='main'); return $docs;
    }

    private function tournamentStatus(string $html,int $synced): string
    {
        if(preg_match('/\bChampion\b/i',$this->parser->visibleText($html)))return 'completed';
        return $synced>0?'in_progress':'ready';
    }
}
