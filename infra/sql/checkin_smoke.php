<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\TournamentCheckinRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentWizardRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if(PHP_SAPI!=='cli')exit(2);
$root=dirname(__DIR__,2);require $root.'/apps/api/bootstrap.php';$config=Config::load($root.'/apps/api');$database=new Database($config);$db=$database->connection();$p=$database->tablePrefix();
$assert=static function(bool $ok,string $msg):void{if(!$ok)throw new RuntimeException($msg);};
$suffix=strtolower(substr(bin2hex(random_bytes(6)),0,12));$ids=['club'=>0,'t1'=>0,'t2'=>0,'a'=>0,'b'=>0,'c'=>0];
try{
 $name='Checkin Smoke '.$suffix;$slug='checkin-smoke-'.$suffix;$s=$db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)',$p));$s->bind_param('ss',$name,$slug);$s->execute();$ids['club']=(int)$s->insert_id;$s->close();
 foreach(['Checkin A','Checkin B','Checkin C'] as $i=>$player){$s=$db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id,display_name) VALUES (?,?)',$p));$s->bind_param('is',$ids['club'],$player);$s->execute();$ids[['a','b','c'][$i]]=(int)$s->insert_id;$s->close();}
 $start1=date('Y-m-d H:i:s',time()+1800);$tn1='Onsite '.$suffix;$ts1='onsite-'.$suffix;$s=$db->prepare(sprintf('INSERT INTO `%1$stournaments` (club_id,name,slug,status,start_at) VALUES (?,?,?,"draft",?)',$p));$s->bind_param('isss',$ids['club'],$tn1,$ts1,$start1);$s->execute();$ids['t1']=(int)$s->insert_id;$s->close();
 $start2=date('Y-m-d H:i:s',time()+10800);$tn2='Early '.$suffix;$ts2='early-'.$suffix;$s=$db->prepare(sprintf('INSERT INTO `%1$stournaments` (club_id,name,slug,status,start_at) VALUES (?,?,?,"draft",?)',$p));$s->bind_param('isss',$ids['club'],$tn2,$ts2,$start2);$s->execute();$ids['t2']=(int)$s->insert_id;$s->close();
 foreach([[$ids['t1'],$ids['a']],[$ids['t1'],$ids['b']],[$ids['t2'],$ids['c']]] as [$t,$player]){$status='registered';$s=$db->prepare(sprintf('INSERT INTO `%1$stournament_players` (tournament_id,player_id,status) VALUES (?,?,?)',$p));$s->bind_param('iis',$t,$player,$status);$s->execute();$s->close();}
 $db->query(sprintf('INSERT INTO `%1$sclub_checkin_settings` (club_id,venue_latitude,venue_longitude,onsite_radius_meters,opens_minutes_before_start,closes_minutes_after_start,require_geolocation,max_location_accuracy_meters) VALUES (%2$d,58.0000000,8.0000000,150,60,10,1,250)',$p,$ids['club']));
 $repo=new TournamentCheckinRepository($database);
 $ok=$repo->checkInPlayer($ids['t1'],$ids['a'],58.0001,8.0001,12.0,false);$assert(($ok['status']??'')==='checked_in','Valid onsite player did not check in.');$assert(($ok['checkin_source']??'')==='player_geolocation','Check-in source not logged.');
 $outside=false;try{$repo->checkInPlayer($ids['t1'],$ids['b'],59.0,9.0,10.0,false);}catch(ValidationException $e){$outside=$e->errorCode()==='checkin_not_onsite';}$assert($outside,'Offsite player was not rejected.');
 $early=false;try{$repo->checkInPlayer($ids['t2'],$ids['c'],58.0,8.0,10.0,false);}catch(ValidationException $e){$early=$e->errorCode()==='checkin_not_open';}$assert($early,'Early check-in was not rejected.');
 $override=$repo->checkInPlayer($ids['t2'],$ids['c'],null,null,null,true);$assert(($override['checkin_source']??'')==='admin_override','Admin override was not audited.');
 $wizard=new TournamentWizardRepository($database);$plan=$wizard->updatePlan($ids['t1'],['group_count'=>4,'group_draw_mode'=>'elo_pots','group_best_of_legs'=>3,'qualifiers_per_group'=>2,'playoff_best_of_legs'=>5]);$assert((int)$plan['group_count']===4,'Wizard group plan not persisted.');$assert($plan['group_draw_mode']==='elo_pots','Wizard draw mode not persisted.');$assert((int)$plan['playoff_best_of_legs']===5,'Wizard playoff plan not persisted.');
 echo "Onsite check-in/tournament wizard smoke OK\n";
}finally{
 foreach(['t1','t2'] as $key)if($ids[$key]){$db->query(sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d',$p,$ids[$key]));$db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d',$p,$ids[$key]));}
 if($ids['club'])$db->query(sprintf('DELETE FROM `%1$sclub_checkin_settings` WHERE club_id=%2$d',$p,$ids['club']));
 foreach(['a','b','c'] as $key)if($ids[$key])$db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d',$p,$ids[$key]));
 if($ids['club'])$db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d',$p,$ids['club']));
}
