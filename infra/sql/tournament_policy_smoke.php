<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\TournamentPolicyRepository;
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
$assert = static function (bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); };
$suffix = strtolower(substr(bin2hex(random_bytes(6)), 0, 12));
$ids = ['club'=>0,'season'=>0,'free'=>0,'paid'=>0];

try {
    $name='Policy Smoke '.$suffix; $slug='policy-smoke-'.$suffix;
    $stmt=$db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug,billing_mode,tournament_fee_ore) VALUES (?,? ,"free",0)',$p));
    $stmt->bind_param('ss',$name,$slug);$stmt->execute();$ids['club']=(int)$stmt->insert_id;$stmt->close();

    $seasonName='Smoke Series '.$suffix;
    $stmt=$db->prepare(sprintf('INSERT INTO `%1$sseasons` (club_id,name,is_active,status) VALUES (?,?,1,"active")',$p));
    $stmt->bind_param('is',$ids['club'],$seasonName);$stmt->execute();$ids['season']=(int)$stmt->insert_id;$stmt->close();

    $clock=$db->query('SELECT DATE_ADD(NOW(), INTERVAL 8 DAY) AS starts')->fetch_assoc();
    $start=(string)$clock['starts'];
    $repo=new TournamentPolicyRepository($database);

    // Explicit null must not silently attach the active season.
    $free=$repo->createTournament($ids['club'],[
        'name'=>'Standalone '.$suffix,
        'start_at'=>$start,
        'season_id'=>null,
        'max_players'=>24,
    ]);
    $ids['free']=(int)$free['id'];
    $assert($free['season_id']===null,'Standalone tournament was implicitly attached to active season.');
    $assert((string)$free['billing_status']==='waived','Free club tournament was not waived.');
    $assert((int)$free['billing_amount_ore']===0,'Free club tournament received a fee.');
    $assert(strtotime((string)$free['registration_opens_at'])===strtotime($start)-167*3600,'Registration did not open exactly 167 hours before planned start.');
    $assert(strtotime((string)$free['checkin_opens_at'])===strtotime($start)-2*3600,'Check-in did not open exactly 2 hours before planned start.');
    $assert($free['registration_closes_at']===null,'Registration had a separate closing deadline before Start.');
    $assert($free['checkin_closes_at']===null,'Product policy exposed a separate check-in closing deadline before Start.');

    $started=$repo->startTournament($ids['free']);
    $assert((string)$started['status']==='in_progress','Explicit Start did not start tournament.');
    $assert($started['actual_started_at']!==null,'Explicit Start did not persist actual_started_at.');
    $assert($started['registration_closes_at']!==null,'Registration did not close on Start.');
    $assert($started['checkin_closes_at']!==null,'Check-in did not close on Start.');
    $assert((int)$started['auto_assign_enabled']===1,'Tournament runtime was not enabled on Start.');

    $repo->updateClubBilling($ids['club'],['billing_mode'=>'stripe','tournament_fee_ore'=>12500]);
    $paid=$repo->createTournament($ids['club'],[
        'name'=>'Paid '.$suffix,
        'start_at'=>$start,
        'season_id'=>$ids['season'],
    ]);
    $ids['paid']=(int)$paid['id'];
    $assert((int)$paid['season_id']===$ids['season'],'Selected season was not persisted.');
    $assert((string)$paid['billing_status']==='pending','Stripe tournament did not start as pending payment.');
    $assert((int)$paid['billing_amount_ore']===12500,'Stripe tournament did not snapshot club fee.');

    $blocked=false;
    try { $repo->startTournament($ids['paid']); }
    catch (ValidationException $error) { $blocked=$error->errorCode()==='tournament_payment_required'; }
    $assert($blocked,'Unpaid Stripe tournament was allowed to start.');

    echo "Tournament timing, season and billing policy smoke OK\n";
} finally {
    foreach (['free','paid'] as $key) if ($ids[$key]) $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d',$p,$ids[$key]));
    if ($ids['season']) $db->query(sprintf('DELETE FROM `%1$sseasons` WHERE id=%2$d',$p,$ids['season']));
    if ($ids['club']) $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d',$p,$ids['club']));
}
