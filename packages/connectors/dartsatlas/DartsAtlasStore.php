<?php

declare(strict_types=1);

final class DartsAtlasStore
{
    private string $p;

    public function __construct(private mysqli $db, string $tablePrefix)
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $tablePrefix)) throw new InvalidArgumentException('Invalid table prefix.');
        $this->p = $tablePrefix;
    }

    public function ensureClub(string $name, string $slug): int
    {
        $table = $this->p . 'clubs';
        $stmt = $this->db->prepare("SELECT id FROM `{$table}` WHERE slug = ? LIMIT 1");
        $stmt->bind_param('s', $slug); $stmt->execute(); $row = $stmt->get_result()->fetch_assoc(); $stmt->close();
        if ($row) return (int) $row['id'];
        $stmt = $this->db->prepare("INSERT INTO `{$table}` (name, slug) VALUES (?, ?)");
        $stmt->bind_param('ss', $name, $slug); $stmt->execute(); $id = (int) $stmt->insert_id; $stmt->close();
        return $id;
    }

    public function reference(string $system, string $entityType, string $externalId, string $internalType): ?int
    {
        $table = $this->p . 'external_references';
        $stmt = $this->db->prepare("SELECT internal_id FROM `{$table}` WHERE external_system=? AND external_entity_type=? AND external_id=? AND internal_entity_type=? LIMIT 1");
        $stmt->bind_param('ssss', $system, $entityType, $externalId, $internalType); $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc(); $stmt->close();
        return $row ? (int) $row['internal_id'] : null;
    }

    public function upsertReference(string $system, string $entityType, string $externalId, string $internalType, int $internalId, string $state = 'synced'): void
    {
        $table = $this->p . 'external_references';
        $stmt = $this->db->prepare("INSERT INTO `{$table}` (external_system,external_entity_type,external_id,internal_entity_type,internal_id,sync_state,last_synced_at) VALUES (?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),internal_id=VALUES(internal_id),sync_state=VALUES(sync_state),last_synced_at=NOW()");
        $stmt->bind_param('ssssis', $system, $entityType, $externalId, $internalType, $internalId, $state); $stmt->execute(); $stmt->close();
    }

    public function memberForPlayer(int $playerId): ?int
    {
        $table = $this->p . 'external_references';
        $system='blindleia_admin'; $entity='member'; $internal='player';
        $stmt = $this->db->prepare("SELECT external_id FROM `{$table}` WHERE external_system=? AND external_entity_type=? AND internal_entity_type=? AND internal_id=? LIMIT 1");
        $stmt->bind_param('sssi', $system, $entity, $internal, $playerId); $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc(); $stmt->close();
        return $row ? (int) $row['external_id'] : null;
    }

    public function playerExists(int $clubId, int $playerId): bool
    {
        $table = $this->p . 'players';
        $stmt = $this->db->prepare("SELECT id FROM `{$table}` WHERE id=? AND club_id=? LIMIT 1");
        $stmt->bind_param('ii', $playerId, $clubId); $stmt->execute(); $ok = (bool) $stmt->get_result()->fetch_assoc(); $stmt->close();
        return $ok;
    }

    public function createPlayer(int $clubId, string $name): int
    {
        $table = $this->p . 'players';
        $stmt = $this->db->prepare("INSERT INTO `{$table}` (club_id,display_name,is_active) VALUES (?,?,1)");
        $stmt->bind_param('is', $clubId, $name); $stmt->execute(); $id=(int)$stmt->insert_id; $stmt->close(); return $id;
    }

    public function renamePlayer(int $playerId, string $name): void
    {
        $table = $this->p . 'players'; $stmt=$this->db->prepare("UPDATE `{$table}` SET display_name=? WHERE id=?");
        $stmt->bind_param('si', $name, $playerId); $stmt->execute(); $stmt->close();
    }

    public function ensureSeason(int $clubId, string $externalId, string $name): int
    {
        $existing = $this->reference('dartsatlas','season',$externalId,'season');
        if ($existing !== null) return $existing;
        $table=$this->p.'seasons'; $stmt=$this->db->prepare("INSERT INTO `{$table}` (club_id,name,is_active) VALUES (?,?,0)");
        $stmt->bind_param('is',$clubId,$name); $stmt->execute(); $id=(int)$stmt->insert_id; $stmt->close();
        $this->upsertReference('dartsatlas','season',$externalId,'season',$id); return $id;
    }

    /** @param array<string,mixed> $metadata */
    public function upsertTournament(int $clubId, ?int $seasonId, string $externalId, string $title, ?DateTimeImmutable $startAt, array $metadata): int
    {
        $table=$this->p.'tournaments'; $existing=$this->reference('dartsatlas','tournament',$externalId,'tournament');
        $provider='dartsatlas'; $json=json_encode($metadata,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES); $start=$startAt?->format('Y-m-d H:i:s');
        if ($existing !== null) {
            $stmt=$this->db->prepare("UPDATE `{$table}` SET name=?,season_id=COALESCE(?,season_id),provider_system=?,provider_metadata=?,start_at=COALESCE(?,start_at),updated_at=NOW() WHERE id=?");
            $stmt->bind_param('sisssi',$title,$seasonId,$provider,$json,$start,$existing); $stmt->execute(); $stmt->close(); return $existing;
        }
        $status='ready'; $stmt=$this->db->prepare("INSERT INTO `{$table}` (club_id,season_id,name,provider_system,provider_metadata,status,start_at) VALUES (?,?,?,?,?,?,?)");
        $stmt->bind_param('iisssss',$clubId,$seasonId,$title,$provider,$json,$status,$start); $stmt->execute(); $id=(int)$stmt->insert_id; $stmt->close();
        $this->upsertReference('dartsatlas','tournament',$externalId,'tournament',$id); return $id;
    }

    public function updateTournamentStatus(int $id, string $status): void
    {
        $table=$this->p.'tournaments'; $stmt=$this->db->prepare("UPDATE `{$table}` SET status=?,end_at=CASE WHEN ?='completed' THEN COALESCE(end_at,NOW()) ELSE end_at END,updated_at=NOW() WHERE id=?");
        $stmt->bind_param('ssi',$status,$status,$id); $stmt->execute(); $stmt->close();
    }

    public function upsertMatch(int $tournamentId, string $externalId, int $a, int $b, string $liveStatus): int
    {
        $table=$this->p.'matches'; $existing=$this->reference('dartsatlas','match',$externalId,'match');
        $status=match($liveStatus){'live'=>'in_progress','completed'=>'completed',default=>'pending'};
        if ($existing !== null) {
            $stmt=$this->db->prepare("UPDATE `{$table}` SET tournament_id=?,player_a_id=?,player_b_id=?,status=?,starts_at=CASE WHEN ?='in_progress' AND starts_at IS NULL THEN NOW() ELSE starts_at END,finished_at=CASE WHEN ?='completed' THEN COALESCE(finished_at,NOW()) ELSE finished_at END,updated_at=NOW() WHERE id=?");
            $stmt->bind_param('iiisssi',$tournamentId,$a,$b,$status,$status,$status,$existing); $stmt->execute(); $stmt->close(); return $existing;
        }
        $best=3; $win=2; $stmt=$this->db->prepare("INSERT INTO `{$table}` (tournament_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id,starts_at,finished_at) VALUES (?,?,?,?,?,?,CASE WHEN ?='in_progress' THEN NOW() ELSE NULL END,CASE WHEN ?='completed' THEN NOW() ELSE NULL END)");
        $stmt->bind_param('isiiiiss',$tournamentId,$status,$best,$win,$a,$b,$status,$status); $stmt->execute(); $id=(int)$stmt->insert_id; $stmt->close();
        $this->upsertReference('dartsatlas','match',$externalId,'match',$id); return $id;
    }

    /** @param array<string,mixed> $snapshot */
    public function upsertLiveState(int $matchId, string $externalId, array $snapshot): void
    {
        $table=$this->p.'live_match_state'; $broadcast="https://www.dartsatlas.com/matches/{$externalId}/broadcast?mode=dual_cam_stats";
        $stats=json_encode($snapshot['stats'],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES); $hash=hash('sha256',json_encode($snapshot,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));
        $stmt=$this->db->prepare("INSERT INTO `{$table}` (match_id,external_system,external_match_id,board_label,live_status,player_a_legs,player_b_legs,player_a_remaining,player_b_remaining,player_a_average,player_b_average,player_a_first9,player_b_first9,broadcast_url,stats_json,payload_hash,last_observed_at) VALUES (?,'dartsatlas',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE external_match_id=VALUES(external_match_id),board_label=VALUES(board_label),live_status=VALUES(live_status),player_a_legs=VALUES(player_a_legs),player_b_legs=VALUES(player_b_legs),player_a_remaining=VALUES(player_a_remaining),player_b_remaining=VALUES(player_b_remaining),player_a_average=VALUES(player_a_average),player_b_average=VALUES(player_b_average),player_a_first9=VALUES(player_a_first9),player_b_first9=VALUES(player_b_first9),broadcast_url=VALUES(broadcast_url),stats_json=VALUES(stats_json),payload_hash=VALUES(payload_hash),last_observed_at=NOW(),updated_at=NOW()");
        $stmt->bind_param('isssiiiiddddsss',$matchId,$externalId,$snapshot['board_label'],$snapshot['status'],$snapshot['player_a_legs'],$snapshot['player_b_legs'],$snapshot['player_a_remaining'],$snapshot['player_b_remaining'],$snapshot['player_a_average'],$snapshot['player_b_average'],$snapshot['player_a_first9'],$snapshot['player_b_first9'],$broadcast,$stats,$hash); $stmt->execute(); $stmt->close();
    }

    public function startJob(string $jobType): int
    {
        $table=$this->p.'connector_sync_jobs'; $system='dartsatlas'; $status='running';
        $stmt=$this->db->prepare("INSERT INTO `{$table}` (external_system,job_type,status,started_at) VALUES (?,?,?,NOW())");
        $stmt->bind_param('sss',$system,$jobType,$status); $stmt->execute(); $id=(int)$stmt->insert_id; $stmt->close(); return $id;
    }

    public function scopeJob(int $jobId, int $tournamentId): void
    {
        $table=$this->p.'connector_sync_jobs'; $type='tournament'; $stmt=$this->db->prepare("UPDATE `{$table}` SET scope_entity_type=?,scope_entity_id=? WHERE id=?");
        $stmt->bind_param('sii',$type,$tournamentId,$jobId); $stmt->execute(); $stmt->close();
    }

    /** @param array<string,mixed> $summary */
    public function finishJob(int $jobId, string $status, array $summary, ?string $error=null): void
    {
        $table=$this->p.'connector_sync_jobs'; $json=json_encode($summary,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        $stmt=$this->db->prepare("UPDATE `{$table}` SET status=?,summary_json=?,error_message=?,finished_at=NOW() WHERE id=?");
        $stmt->bind_param('sssi',$status,$json,$error,$jobId); $stmt->execute(); $stmt->close();
    }

    /** @return array<string,mixed> */
    public function liveState(int $clubId): array
    {
        $m=$this->p.'matches'; $p=$this->p.'players'; $t=$this->p.'tournaments'; $l=$this->p.'live_match_state'; $r=$this->p.'external_references';
        $sql="SELECT m.id match_id,t.id tournament_id,t.name tournament_name,t.status tournament_status,m.round_label,m.bracket_label,m.status match_status,pa.id player_a_id,pa.display_name player_a_name,pb.id player_b_id,pb.display_name player_b_name,l.external_match_id,l.board_label,l.live_status,l.player_a_legs,l.player_b_legs,l.player_a_remaining,l.player_b_remaining,l.player_a_average,l.player_b_average,l.player_a_first9,l.player_b_first9,l.broadcast_url,l.stats_json,l.last_observed_at,ra.external_id player_a_member_id,rb.external_id player_b_member_id FROM `{$m}` m JOIN `{$t}` t ON t.id=m.tournament_id JOIN `{$p}` pa ON pa.id=m.player_a_id JOIN `{$p}` pb ON pb.id=m.player_b_id LEFT JOIN `{$l}` l ON l.match_id=m.id LEFT JOIN `{$r}` ra ON ra.external_system='blindleia_admin' AND ra.external_entity_type='member' AND ra.internal_entity_type='player' AND ra.internal_id=pa.id LEFT JOIN `{$r}` rb ON rb.external_system='blindleia_admin' AND rb.external_entity_type='member' AND rb.internal_entity_type='player' AND rb.internal_id=pb.id WHERE t.club_id=? AND t.status IN ('ready','in_progress') ORDER BY CASE l.live_status WHEN 'live' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,l.last_observed_at DESC,m.id DESC";
        $stmt=$this->db->prepare($sql); $stmt->bind_param('i',$clubId); $stmt->execute(); $result=$stmt->get_result(); $matches=[];
        while($row=$result->fetch_assoc()){
            $stats=[]; if(!empty($row['stats_json'])){ $decoded=json_decode((string)$row['stats_json'],true); if(is_array($decoded))$stats=$decoded; }
            $matches[]=[
                'match_id'=>(int)$row['match_id'],'external_match_id'=>$row['external_match_id'],
                'tournament'=>['id'=>(int)$row['tournament_id'],'name'=>(string)$row['tournament_name'],'status'=>(string)$row['tournament_status']],
                'round'=>$row['round_label'],'bracket'=>$row['bracket_label'],'status'=>$row['live_status']?:$row['match_status'],'board'=>$row['board_label'],
                'player_a'=>$this->playerState($row,'a'),'player_b'=>$this->playerState($row,'b'),
                'broadcast_url'=>$row['broadcast_url'],'stats'=>$stats,'observed_at'=>$row['last_observed_at'],
            ];
        }
        $stmt->close(); return ['club_id'=>$clubId,'generated_at'=>(new DateTimeImmutable())->format(DateTimeInterface::ATOM),'matches'=>$matches];
    }

    /** @param array<string,mixed> $row */
    private function playerState(array $row,string $side): array
    {
        $key='player_'.$side.'_';
        return ['id'=>(int)$row[$key.'id'],'member_id'=>$row[$key.'member_id']===null?null:(int)$row[$key.'member_id'],'name'=>(string)$row[$key.'name'],'legs'=>$row[$key.'legs']===null?null:(int)$row[$key.'legs'],'remaining'=>$row[$key.'remaining']===null?null:(int)$row[$key.'remaining'],'average'=>$row[$key.'average']===null?null:(float)$row[$key.'average'],'first9'=>$row[$key.'first9']===null?null:(float)$row[$key.'first9']];
    }
}
