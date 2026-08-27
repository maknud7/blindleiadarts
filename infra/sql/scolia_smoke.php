<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Service\ScoliaScoringService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') exit(2);
$root=dirname(__DIR__,2); require $root.'/apps/api/bootstrap.php';
$config=Config::load($root.'/apps/api'); $database=new Database($config); $db=$database->connection(); $p=$database->tablePrefix();
$assert=static function(bool $ok,string $msg):void{if(!$ok)throw new RuntimeException($msg);};
$suffix=strtolower(substr(bin2hex(random_bytes(6)),0,12));
$eventId=static fn(string $base):string=>$base.'-'.$suffix;
$ids=['club'=>0,'tournament'=>0,'kiosk'=>0,'a'=>0,'b'=>0,'match'=>0];
$lockName=$p.'scolia-smoke';$lockWaitSeconds=240;$lockHeld=false;
$s=$db->prepare('SELECT GET_LOCK(?,?) AS locked');$s->bind_param('si',$lockName,$lockWaitSeconds);$s->execute();$lockHeld=(int)($s->get_result()->fetch_assoc()['locked']??0)===1;$s->close();
$assert($lockHeld,'Could not acquire isolated Scolia smoke lock.');
try{
  $name='Scolia Smoke '.$suffix;$slug='scolia-smoke-'.$suffix;$s=$db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)',$p));$s->bind_param('ss',$name,$slug);$s->execute();$ids['club']=(int)$s->insert_id;$s->close();
  foreach(['Scolia A','Scolia B'] as $i=>$player){$s=$db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id,display_name) VALUES (?,?)',$p));$s->bind_param('is',$ids['club'],$player);$s->execute();$ids[$i===0?'a':'b']=(int)$s->insert_id;$s->close();}
  $tn='Scolia Tournament '.$suffix;$ts='scolia-tournament-'.$suffix;$s=$db->prepare(sprintf('INSERT INTO `%1$stournaments` (club_id,name,slug,provider_system,status,start_at) VALUES (?,?,?,"local","ready",NOW())',$p));$s->bind_param('iss',$ids['club'],$tn,$ts);$s->execute();$ids['tournament']=(int)$s->insert_id;$s->close();
  $code='SCOLIA-'.strtoupper(substr($suffix,0,8));$kn='Scolia Board';$boardNo=977;$s=$db->prepare(sprintf('INSERT INTO `%1$skiosks` (club_id,code,name,board_number,scoring_mode) VALUES (?,?,?, ?,"scolia")',$p));$s->bind_param('issi',$ids['club'],$code,$kn,$boardNo);$s->execute();$ids['kiosk']=(int)$s->insert_id;$s->close();
  $serial='SERIAL-'.$suffix;
  $db->query(sprintf('INSERT INTO `%1$sscolia_club_settings` (club_id,enabled,access_token,disconnect_fallback_enabled) VALUES (%2$d,1,"smoke-token",1)',$p,$ids['club']));
  $s=$db->prepare(sprintf('INSERT INTO `%1$sscolia_board_settings` (kiosk_id,serial_number,mode,auto_fallback_to_manual) VALUES (?,?,"live",1)',$p));$s->bind_param('is',$ids['kiosk'],$serial);$s->execute();$s->close();
  $s=$db->prepare(sprintf('INSERT INTO `%1$smatches` (tournament_id,kiosk_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id) VALUES (?, ?,"assigned",3,2,?,?)',$p));$s->bind_param('iiii',$ids['tournament'],$ids['kiosk'],$ids['a'],$ids['b']);$s->execute();$ids['match']=(int)$s->insert_id;$s->close();

  $scoring=new CanonicalScoringService($database); $repo=new ScoliaRepository($database); $service=new ScoliaScoringService($repo,$scoring,new Dart501Rules());
  $scoring->startMatch($ids['kiosk'],'manual');
  $event=function(string $id,string $type,array $payload=[])use($repo,$serial,$eventId):string{$providerId=$eventId($id);$repo->enqueueEvent($serial,['id'=>$providerId,'type'=>$type,'payload'=>$payload]);return $providerId;};
  $eventState=function(string $providerId)use($db,$p):array{
    $stmt=$db->prepare(sprintf('SELECT processing_status,last_error,processing_meta_json FROM `%1$sscolia_events` WHERE provider_event_id=? LIMIT 1',$p));
    $stmt->bind_param('s',$providerId);$stmt->execute();$row=$stmt->get_result()->fetch_assoc()?:[];$stmt->close();
    return ['status'=>(string)($row['processing_status']??'missing'),'error'=>(string)($row['last_error']??''),'meta'=>json_decode((string)($row['processing_meta_json']??'{}'),true)?:[]];
  };
  $drainOwn=function(array $providerIds,string $label)use($service,$eventState,$assert):void{
    $remaining=array_fill_keys($providerIds,true);
    for($attempt=1;$attempt<=20 && $remaining!==[];$attempt++){
      $service->drain(100);
      foreach(array_keys($remaining) as $providerId){
        $state=$eventState($providerId);$status=$state['status'];
        if(in_array($status,['processed','ignored'],true)){unset($remaining[$providerId]);continue;}
        if(in_array($status,['failed','dead_letter'],true)){
          $error=trim((string)$state['error']);
          throw new RuntimeException("{$label} event {$providerId} failed: ".($error!==''?$error:$status));
        }
      }
    }
    $assert($remaining===[],"{$label} events were not drained from the shared Scolia queue: ".implode(',',array_keys($remaining)));
  };

  $liveEvents=[
    $event('e1','THROW_DETECTED',['sector'=>'T20','bounceout'=>false]),
    $event('e2','THROW_DETECTED',['sector'=>'T20','bounceout'=>false]),
    $event('e3','THROW_DETECTED',['sector'=>'T20','bounceout'=>false]),
    $event('e4','TAKEOUT_FINISHED',['falseTakeout'=>false]),
  ];
  $duplicate=$repo->enqueueEvent($serial,['id'=>$liveEvents[2],'type'=>'THROW_DETECTED','payload'=>['sector'=>'T20','bounceout'=>false]]);$assert($duplicate['duplicate']===true,'Provider event dedupe failed.');
  $drainOwn($liveEvents,'Live Scolia');
  $s=$db->prepare(sprintf('SELECT score,darts_used,request_key FROM `%1$svisits` WHERE match_id=? ORDER BY id',$p));$s->bind_param('i',$ids['match']);$s->execute();$visits=$s->get_result()->fetch_all(MYSQLI_ASSOC);$s->close();
  $assert(count($visits)===1,'Live Scolia should create exactly one canonical visit.');$assert((int)$visits[0]['score']===180,'Live Scolia 180 score wrong.');$assert(str_starts_with((string)$visits[0]['request_key'],'scolia-'),'Canonical Scolia request key missing.');

  $disconnectEvent=$event('disconnect-1','BRIDGE_DISCONNECTED',['reason'=>'smoke disconnect']);$drainOwn([$disconnectEvent],'Disconnect');
  $s=$db->prepare(sprintf('SELECT fallback_active,needs_reconciliation FROM `%1$sscolia_board_runtime` WHERE kiosk_id=?',$p));$s->bind_param('i',$ids['kiosk']);$s->execute();$runtime=$s->get_result()->fetch_assoc()?:[];$s->close();
  $assert((int)($runtime['fallback_active']??0)===1,'Disconnect did not activate manual fallback.');$assert((int)($runtime['needs_reconciliation']??0)===1,'Disconnect did not require reconciliation.');
  $scoring->recordVisit($ids['kiosk'],['input_mode'=>'sum','score'=>60,'darts_used'=>3,'request_id'=>'manual-fallback-'.$suffix],'manual');
  $s=$db->prepare(sprintf('SELECT COUNT(*) c FROM `%1$svisits` WHERE match_id=?',$p));$s->bind_param('i',$ids['match']);$s->execute();$assert((int)($s->get_result()->fetch_assoc()['c']??0)===2,'Manual scoring did not continue during Scolia fallback.');$s->close();
  $ignoredId=$event('ignored-1','THROW_DETECTED',['sector'=>'T20']);$drainOwn([$ignoredId],'Fallback ignore');
  $ignoredState=$eventState($ignoredId);$assert($ignoredState['status']==='ignored','Scolia event was not ignored during manual fallback.');

  $db->query(sprintf('UPDATE `%1$sscolia_board_runtime` SET fallback_active=0,needs_reconciliation=0,turn_locked_until_takeout=0 WHERE kiosk_id=%2$d',$p,$ids['kiosk']));
  $db->query(sprintf('UPDATE `%1$sscolia_board_settings` SET mode="shadow" WHERE kiosk_id=%2$d',$p,$ids['kiosk']));
  $shadowEvents=[
    $event('s1','THROW_DETECTED',['sector'=>'T20']),
    $event('s2','THROW_DETECTED',['sector'=>'T19']),
    $event('s3','THROW_DETECTED',['sector'=>'T18']),
    $event('s4','TAKEOUT_FINISHED',['falseTakeout'=>false]),
  ];
  $drainOwn($shadowEvents,'Shadow Scolia');
  foreach(array_slice($shadowEvents,0,3) as $index=>$providerId){
    $state=$eventState($providerId);$meta=$state['meta'];
    $assert($state['status']==='processed',sprintf('Shadow throw %d was %s: %s', $index+1, $state['status'], json_encode($meta,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE)));
  }
  $shadowFinal=$eventState($shadowEvents[2]);
  $assert((int)($shadowFinal['meta']['shadow_visit_id']??0)>0,'Third shadow throw did not create a shadow visit: '.json_encode($shadowFinal['meta'],JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE));
  $assert((int)($shadowFinal['meta']['score']??0)===171,'Third shadow throw produced wrong meta score: '.json_encode($shadowFinal['meta'],JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE));
  $s=$db->prepare(sprintf('SELECT score FROM `%1$sscolia_shadow_visits` WHERE match_id=? ORDER BY id DESC LIMIT 1',$p));$s->bind_param('i',$ids['match']);$s->execute();$shadow=$s->get_result()->fetch_assoc()?:[];$s->close();$shadowScore=(int)($shadow['score']??0);$assert($shadowScore===171,"Shadow visit score wrong: {$shadowScore}.");
  $s=$db->prepare(sprintf('SELECT COUNT(*) c FROM `%1$svisits` WHERE match_id=?',$p));$s->bind_param('i',$ids['match']);$s->execute();$assert((int)($s->get_result()->fetch_assoc()['c']??0)===2,'Shadow scoring changed canonical visits.');$s->close();
  echo "Scolia live/shadow/fallback canonical scoring smoke OK\n";
}finally{
  if($ids['match']) {foreach(['scolia_shadow_visits','scolia_visit_buffers','scolia_events','match_statistics','live_match_states','visits','legs'] as $table){$db->query(sprintf('DELETE FROM `%1$s%2$s` WHERE match_id=%3$d',$p,$table,$ids['match']));}$db->query(sprintf('DELETE FROM `%1$sscolia_incidents` WHERE match_id=%2$d',$p,$ids['match']));$db->query(sprintf('DELETE FROM `%1$smatches` WHERE id=%2$d',$p,$ids['match']));}
  if($ids['kiosk']) {foreach(['scolia_commands','scolia_board_runtime','scolia_board_settings'] as $table){$db->query(sprintf('DELETE FROM `%1$s%2$s` WHERE kiosk_id=%3$d',$p,$table,$ids['kiosk']));}$db->query(sprintf('DELETE FROM `%1$skiosks` WHERE id=%2$d',$p,$ids['kiosk']));}
  if($ids['club']) {$db->query(sprintf('DELETE FROM `%1$sscolia_incidents` WHERE club_id=%2$d',$p,$ids['club']));$db->query(sprintf('DELETE FROM `%1$sscolia_club_settings` WHERE club_id=%2$d',$p,$ids['club']));}
  if($ids['tournament']) $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d',$p,$ids['tournament']));
  foreach(['a','b'] as $k)if($ids[$k])$db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d',$p,$ids[$k]));
  if($ids['club']) $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d',$p,$ids['club']));
  if($lockHeld){$s=$db->prepare('SELECT RELEASE_LOCK(?)');$s->bind_param('s',$lockName);$s->execute();$s->close();}
}
