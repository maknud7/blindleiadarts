<?php

declare(strict_types=1);

final class BlindleiaPlayerIdentityResolver
{
    public function __construct(
        private DartsAtlasStore $store,
        private BlindleiaMemberDirectory $members,
        private int $clubId
    ) {}

    /** @param array{id:string,name:string} $externalPlayer @return array{player_id:int,member_id:?int,link_state:string} */
    public function resolve(array $externalPlayer): array
    {
        $externalId=trim($externalPlayer['id']); $name=trim($externalPlayer['name']);
        if($externalId===''||$name==='') throw new InvalidArgumentException('Darts Atlas player needs id and name.');

        $playerId=$this->store->reference('dartsatlas','player',$externalId,'player');
        if($playerId!==null){
            $this->store->renamePlayer($playerId,$name);
            $memberId=$this->store->memberForPlayer($playerId);
            if($memberId!==null) return ['player_id'=>$playerId,'member_id'=>$memberId,'link_state'=>'linked'];
            return $this->tryMemberLink($playerId,$name);
        }

        $memberMatches=$this->members->exactName($name);
        if(count($memberMatches)===1){
            $memberId=(int)$memberMatches[0]['id'];
            $memberPlayer=$this->store->reference('blindleia_admin','member',(string)$memberId,'player');
            if($memberPlayer!==null){
                $this->store->upsertReference('dartsatlas','player',$externalId,'player',$memberPlayer);
                $this->store->renamePlayer($memberPlayer,$name);
                return ['player_id'=>$memberPlayer,'member_id'=>$memberId,'link_state'=>'linked'];
            }
        }

        // Stable Darts Atlas id wins over name: never merge unrelated guests by display name.
        $playerId=$this->store->createPlayer($this->clubId,$name);
        $this->store->upsertReference('dartsatlas','player',$externalId,'player',$playerId);
        return $this->tryMemberLink($playerId,$name,$memberMatches);
    }

    public function manuallyLink(int $playerId,int $memberId): void
    {
        if(!$this->store->playerExists($this->clubId,$playerId)) throw new RuntimeException("Player {$playerId} does not exist in this club.");
        if(!$this->members->exists($memberId)) throw new RuntimeException("Member {$memberId} does not exist in the member register.");
        $currentMember=$this->store->memberForPlayer($playerId);
        if($currentMember!==null&&$currentMember!==$memberId) throw new RuntimeException("Player {$playerId} is already linked to member {$currentMember}.");
        $memberPlayer=$this->store->reference('blindleia_admin','member',(string)$memberId,'player');
        if($memberPlayer!==null&&$memberPlayer!==$playerId) throw new RuntimeException("Member {$memberId} is already linked to player {$memberPlayer}.");
        $this->store->upsertReference('blindleia_admin','member',(string)$memberId,'player',$playerId);
    }

    /** @param null|list<array{id:int,medlemsnummer:?int,navn:string}> $matches */
    private function tryMemberLink(int $playerId,string $name,?array $matches=null): array
    {
        $matches??=$this->members->exactName($name);
        if(count($matches)!==1) return ['player_id'=>$playerId,'member_id'=>null,'link_state'=>count($matches)>1?'ambiguous_member':'unlinked'];
        $memberId=(int)$matches[0]['id'];
        $memberPlayer=$this->store->reference('blindleia_admin','member',(string)$memberId,'player');
        if($memberPlayer!==null&&$memberPlayer!==$playerId) return ['player_id'=>$playerId,'member_id'=>null,'link_state'=>'member_already_linked'];
        $this->store->upsertReference('blindleia_admin','member',(string)$memberId,'player',$playerId);
        return ['player_id'=>$playerId,'member_id'=>$memberId,'link_state'=>'linked'];
    }
}
