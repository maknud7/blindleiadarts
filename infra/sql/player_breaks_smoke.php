<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\PlayerBreakRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentOperationsRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') { exit(2); }
$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
$config = Config::load($root . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();
$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$suffix = strtolower(substr(bin2hex(random_bytes(6)), 0, 12));
$ids = ['club'=>0,'season'=>0,'tournament'=>0,'board'=>0,'player_a'=>0,'player_b'=>0,'player_c'=>0,'match_1'=>0,'match_2'=>0];

try {
    $clubName = 'Break Smoke ' . $suffix;
    $clubSlug = 'break-smoke-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name, slug) VALUES (?, ?)', $prefix));
    $stmt->bind_param('ss', $clubName, $clubSlug); $stmt->execute(); $ids['club']=(int)$stmt->insert_id; $stmt->close();

    $seasonName='Break Season '.$suffix; $starts=date('Y-m-d'); $ends=date('Y-m-d', strtotime('+1 month')); $active=1;
    $stmt=$db->prepare(sprintf('INSERT INTO `%1$sseasons` (club_id,name,starts_on,ends_on,is_active) VALUES (?,?,?,?,?)',$prefix));
    $stmt->bind_param('isssi',$ids['club'],$seasonName,$starts,$ends,$active); $stmt->execute(); $ids['season']=(int)$stmt->insert_id; $stmt->close();

    $tournamentName='Break Tournament '.$suffix; $slug='break-tournament-'.$suffix; $status='ready'; $startAt=date('Y-m-d H:i:s'); $auto=1;
    $stmt=$db->prepare(sprintf('INSERT INTO `%1$stournaments` (club_id,season_id,name,slug,provider_system,status,start_at,auto_assign_enabled) VALUES (?,?,?,? ,"local",?,?,?)',$prefix));
    $stmt->bind_param('iissssi',$ids['club'],$ids['season'],$tournamentName,$slug,$status,$startAt,$auto); $stmt->execute(); $ids['tournament']=(int)$stmt->insert_id; $stmt->close();

    foreach (['a'=>'A','b'=>'B','c'=>'C'] as $key=>$label) {
        $name='Break '.$label.' '.$suffix;
        $stmt=$db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id,display_name) VALUES (?,?)',$prefix));
        $stmt->bind_param('is',$ids['club'],$name); $stmt->execute(); $ids['player_'.$key]=(int)$stmt->insert_id; $stmt->close();
    }
    foreach (['player_a','player_b','player_c'] as $key) {
        $stmt=$db->prepare(sprintf('INSERT INTO `%1$stournament_players` (tournament_id,player_id,status,registration_source) VALUES (?,? ,"checked_in","smoke")',$prefix));
        $stmt->bind_param('ii',$ids['tournament'],$ids[$key]); $stmt->execute(); $stmt->close();
    }

    $code='BRK-'.strtoupper(substr($suffix,0,6)); $boardName='Break Board'; $boardNo=903;
    $stmt=$db->prepare(sprintf('INSERT INTO `%1$skiosks` (club_id,code,name,board_number,is_active) VALUES (?,?,?,?,1)',$prefix));
    $stmt->bind_param('issi',$ids['club'],$code,$boardName,$boardNo); $stmt->execute(); $ids['board']=(int)$stmt->insert_id; $stmt->close();
    $order=1;
    $stmt=$db->prepare(sprintf('INSERT INTO `%1$stournament_kiosks` (tournament_id,kiosk_id,sort_order) VALUES (?,?,?)',$prefix));
    $stmt->bind_param('iii',$ids['tournament'],$ids['board'],$order); $stmt->execute(); $stmt->close();

    $matchSql=sprintf('INSERT INTO `%1$smatches` (tournament_id,round_label,round_number,status,best_of_legs,legs_to_win,player_a_id,player_b_id) VALUES (?,?,? ,"pending",1,1,?,?)',$prefix);
    $round='Runde 1'; $roundNo=1;
    $stmt=$db->prepare($matchSql); $stmt->bind_param('isiii',$ids['tournament'],$round,$roundNo,$ids['player_a'],$ids['player_b']); $stmt->execute(); $ids['match_1']=(int)$stmt->insert_id; $stmt->close();
    $round='Runde 2'; $roundNo=2;
    $stmt=$db->prepare($matchSql); $stmt->bind_param('isiii',$ids['tournament'],$round,$roundNo,$ids['player_b'],$ids['player_c']); $stmt->execute(); $ids['match_2']=(int)$stmt->insert_id; $stmt->close();

    $breaks=new PlayerBreakRepository($database);
    $ops=new TournamentOperationsRepository($database);

    // Immediate break: player A is removed from assignment for exactly the break window.
    $immediate=$breaks->requestBreak($ids['tournament'],$ids['player_a']);
    $assert(($immediate['status'] ?? '')==='active','Immediate break did not become active.');
    $assert((int)($immediate['remaining_seconds'] ?? 0) > 400,'Immediate break was not approximately seven minutes.');
    $reg=$db->query(sprintf('SELECT status FROM `%1$stournament_players` WHERE tournament_id=%2$d AND player_id=%3$d',$prefix,$ids['tournament'],$ids['player_a']))->fetch_assoc();
    $assert(($reg['status'] ?? '')==='paused','Player A registration was not paused.');
    $blocked=$ops->reconcileTournament($ids['tournament']);
    $assert((int)($blocked['assignment']['assigned_count'] ?? 0)===0,'A match was assigned while player A was paused.');

    $db->query(sprintf('UPDATE `%1$stournament_player_breaks` SET ends_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE tournament_id=%2$d AND player_id=%3$d AND status="active"',$prefix,$ids['tournament'],$ids['player_a']));
    $breaks->normalizeTournament($ids['tournament']);
    $reg=$db->query(sprintf('SELECT status FROM `%1$stournament_players` WHERE tournament_id=%2$d AND player_id=%3$d',$prefix,$ids['tournament'],$ids['player_a']))->fetch_assoc();
    $assert(($reg['status'] ?? '')==='checked_in','Player A was not restored after break expiry.');
    $assigned=$ops->reconcileTournament($ids['tournament']);
    $assert((int)($assigned['assignment']['assigned_count'] ?? 0)===1,'First match was not assigned after break expiry.');

    $db->query(sprintf('UPDATE `%1$smatches` SET status="in_progress", starts_at=NOW() WHERE id=%2$d',$prefix,$ids['match_1']));
    $scheduled=$breaks->requestBreak($ids['tournament'],$ids['player_b']);
    $assert(($scheduled['status'] ?? '')==='scheduled','Break during a match was not scheduled.');
    $assert((int)($scheduled['after_match_id'] ?? 0)===$ids['match_1'],'Scheduled break was not tied to the active match.');

    $db->query(sprintf('UPDATE `%1$smatches` SET status="completed", winner_player_id=%2$d, finished_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=%3$d',$prefix,$ids['player_a'],$ids['match_1']));
    $breaks->normalizeTournament($ids['tournament']);
    $activeBreak=$breaks->getStatus($ids['tournament'],$ids['player_b']);
    $assert(($activeBreak['status'] ?? '')==='active','Scheduled break did not activate after match completion.');
    $remaining=(int)($activeBreak['remaining_seconds'] ?? 0);
    $assert($remaining >= 340 && $remaining <= 370,'Scheduled break did not start from match finished_at.');
    $blockedNext=$ops->assignNextToKiosk($ids['board']);
    $assert(($blockedNext['assigned'] ?? true)===false,'Next match was assigned while player B was on break.');

    $db->query(sprintf('UPDATE `%1$stournament_player_breaks` SET ends_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE tournament_id=%2$d AND player_id=%3$d AND status="active"',$prefix,$ids['tournament'],$ids['player_b']));
    $breaks->normalizeTournament($ids['tournament']);
    $next=$ops->assignNextToKiosk($ids['board']);
    $assert(($next['assigned'] ?? false)===true,'Next match was not released after player B break expired.');
    $assert((int)($next['match']['id'] ?? 0)===$ids['match_2'],'Wrong match was assigned after break expiry.');

    echo "Player break smoke OK\n";
} finally {
    if ($ids['tournament']>0) {
        $db->query(sprintf('DELETE FROM `%1$stournament_player_breaks` WHERE tournament_id=%2$d',$prefix,$ids['tournament']));
        foreach (['match_statistics','live_match_states','visits','legs'] as $table) {
            $db->query(sprintf('DELETE target FROM `%1$s%2$s` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%3$d',$prefix,$table,$ids['tournament']));
        }
        $db->query(sprintf('DELETE FROM `%1$smatches` WHERE tournament_id=%2$d',$prefix,$ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_kiosks` WHERE tournament_id=%2$d',$prefix,$ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d',$prefix,$ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d',$prefix,$ids['tournament']));
    }
    if ($ids['board']>0) $db->query(sprintf('DELETE FROM `%1$skiosks` WHERE id=%2$d',$prefix,$ids['board']));
    foreach (['player_a','player_b','player_c'] as $key) if ($ids[$key]>0) $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d',$prefix,$ids[$key]));
    if ($ids['season']>0) $db->query(sprintf('DELETE FROM `%1$sseasons` WHERE id=%2$d',$prefix,$ids['season']));
    if ($ids['club']>0) $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d',$prefix,$ids['club']));
}
