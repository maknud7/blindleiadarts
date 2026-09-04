<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\TournamentCheckinRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentWizardRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') exit(2);
$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
$config = Config::load($root . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$p = $database->tablePrefix();
$assert = static function (bool $ok, string $msg): void { if (!$ok) throw new RuntimeException($msg); };
$suffix = strtolower(substr(bin2hex(random_bytes(6)), 0, 12));
$ids = ['club'=>0,'t1'=>0,'t2'=>0,'a'=>0,'b'=>0,'c'=>0,'d'=>0];

try {
    $name='Checkin Smoke '.$suffix; $slug='checkin-smoke-'.$suffix;
    $s=$db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)',$p)); $s->bind_param('ss',$name,$slug); $s->execute(); $ids['club']=(int)$s->insert_id; $s->close();
    foreach (['Code A','Wrong B','Early C','Admin D'] as $i=>$player) {
        $s=$db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id,display_name) VALUES (?,?)',$p)); $s->bind_param('is',$ids['club'],$player); $s->execute(); $ids[['a','b','c','d'][$i]]=(int)$s->insert_id; $s->close();
    }

    // Use the database clock so the smoke test is independent of the GitHub runner timezone.
    // Check-in belongs to the draft phase; ready means attendance has been finalized.
    $clock=$db->query('SELECT DATE_ADD(NOW(), INTERVAL 30 MINUTE) AS start1, DATE_ADD(NOW(), INTERVAL 3 HOUR) AS start2')->fetch_assoc();
    $start1=(string)$clock['start1']; $tn1='Venue Code '.$suffix; $ts1='venue-code-'.$suffix;
    $s=$db->prepare(sprintf('INSERT INTO `%1$stournaments` (club_id,name,slug,status,start_at) VALUES (?,?,?,"draft",?)',$p)); $s->bind_param('isss',$ids['club'],$tn1,$ts1,$start1); $s->execute(); $ids['t1']=(int)$s->insert_id; $s->close();
    $start2=(string)$clock['start2']; $tn2='Early '.$suffix; $ts2='early-'.$suffix;
    $s=$db->prepare(sprintf('INSERT INTO `%1$stournaments` (club_id,name,slug,status,start_at) VALUES (?,?,?,"draft",?)',$p)); $s->bind_param('isss',$ids['club'],$tn2,$ts2,$start2); $s->execute(); $ids['t2']=(int)$s->insert_id; $s->close();
    foreach ([[$ids['t1'],$ids['a']],[$ids['t1'],$ids['b']],[$ids['t1'],$ids['c']],[$ids['t2'],$ids['c']],[$ids['t1'],$ids['d']]] as [$t,$player]) {
        $status='registered'; $s=$db->prepare(sprintf('INSERT INTO `%1$stournament_players` (tournament_id,player_id,status) VALUES (?,?,?)',$p)); $s->bind_param('iis',$t,$player,$status); $s->execute(); $s->close();
    }
    $db->query(sprintf('INSERT INTO `%1$sclub_checkin_settings` (club_id,default_method,opens_minutes_before_start,closes_minutes_after_start) VALUES (%2$d,"admin_or_code",60,10)',$p,$ids['club']));

    $repo=new TournamentCheckinRepository($database);
    $settings=$repo->updateTournamentSettings($ids['t1'],['checkin_method'=>'admin_or_code']);
    $code=(string)($settings['checkin_code']??'');
    $assert(strlen($code)===3,'Tournament check-in code was not generated as a three-letter code.');

    $byCode=$repo->checkInPlayer($ids['t1'],$ids['a'],false,$code,false);
    $assert(($byCode['status']??'')==='checked_in','Correct venue code did not check player in.');
    $assert(($byCode['checkin_source']??'')==='player_code','Venue code source was not audited.');

    $wrong=false;
    try { $repo->checkInPlayer($ids['t1'],$ids['b'],false,'WRONG1',false); }
    catch (ValidationException $e) { $wrong=$e->errorCode()==='checkin_code_invalid'; }
    $assert($wrong,'Wrong venue code was not rejected.');

    $missing=false;
    try { $repo->checkInPlayer($ids['t1'],$ids['b'],false,null,false); }
    catch (ValidationException $e) { $missing=$e->errorCode()==='checkin_code_required'; }
    $assert($missing,'Missing venue code was not rejected.');

    $repo->updateTournamentSettings($ids['t2'],['checkin_method'=>'admin_or_code']);
    $earlyCode=$repo->getTournamentSettings($ids['t2'])['checkin_code']??'';
    $early=false;
    try { $repo->checkInPlayer($ids['t2'],$ids['c'],false,(string)$earlyCode,false); }
    catch (ValidationException $e) { $early=$e->errorCode()==='checkin_not_open'; }
    $assert($early,'Early code check-in was not rejected.');

    $adminEarly=false;
    try { $repo->checkInPlayer($ids['t2'],$ids['c'],true,null,false); }
    catch (ValidationException $e) { $adminEarly=$e->errorCode()==='checkin_not_open'; }
    $assert($adminEarly,'Normal admin check-in did not respect time window.');

    $forced=$repo->checkInPlayer($ids['t2'],$ids['c'],true,null,true);
    $assert(($forced['checkin_source']??'')==='admin_override','Forced admin check-in was not audited.');

    $admin=$repo->checkInPlayer($ids['t1'],$ids['d'],true,null,false);
    $assert(($admin['checkin_source']??'')==='admin_override','Tournament leader check-in failed inside window.');

    // Complete attendance for the wizard fixture only after the negative check-in
    // cases above have been exercised. Group planning requires at least four
    // checked-in players and at least four players per group.
    $byCodeB=$repo->checkInPlayer($ids['t1'],$ids['b'],false,$code,false);
    $assert(($byCodeB['status']??'')==='checked_in','Wizard fixture player B was not checked in.');
    $byCodeC=$repo->checkInPlayer($ids['t1'],$ids['c'],false,$code,false);
    $assert(($byCodeC['status']??'')==='checked_in','Wizard fixture player C was not checked in.');

    $display=$repo->publicDisplayForClub($ids['club']);
    $assert((int)($display['tournament_id']??0)===$ids['t1'],'Live display selected wrong tournament.');
    $assert(($display['code']??'')===$code,'Live display did not expose current venue code.');

    $wizard=new TournamentWizardRepository($database);
    $plan=$wizard->updatePlan($ids['t1'],['group_count'=>1,'group_draw_mode'=>'elo_pots','group_best_of_legs'=>3,'qualifiers_per_group'=>2,'playoff_best_of_legs'=>5]);
    $assert((int)$plan['group_count']===1,'Wizard group plan not persisted.');
    $assert($plan['group_draw_mode']==='elo_pots','Wizard draw mode not persisted.');
    $assert((int)$plan['playoff_best_of_legs']===5,'Wizard playoff plan not persisted.');

    $tooManyGroups=false;
    try {
        $wizard->updatePlan($ids['t1'],['group_count'=>4,'group_draw_mode'=>'elo_pots','group_best_of_legs'=>3,'qualifiers_per_group'=>2,'playoff_best_of_legs'=>5]);
    } catch (ValidationException $e) {
        $tooManyGroups=$e->errorCode()==='groups_too_small';
    }
    $assert($tooManyGroups,'Wizard accepted four groups with only four checked-in players.');

    echo "Code/admin check-in and tournament wizard smoke OK\n";
} finally {
    foreach (['t1','t2'] as $key) if ($ids[$key]) { $db->query(sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d',$p,$ids[$key])); $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d',$p,$ids[$key])); }
    if ($ids['club']) $db->query(sprintf('DELETE FROM `%1$sclub_checkin_settings` WHERE club_id=%2$d',$p,$ids['club']));
    foreach (['a','b','c','d'] as $key) if ($ids[$key]) $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d',$p,$ids[$key]));
    if ($ids['club']) $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d',$p,$ids['club']));
}
