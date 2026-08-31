<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloLedgerService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

header('Content-Type: application/json; charset=utf-8');
require __DIR__ . '/bootstrap.php';

$config = Config::load(__DIR__);
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();

if ($prefix !== 'bd_test_') {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'test_only']);
    exit;
}

$externalTournamentId = trim((string) ($_GET['tournament'] ?? ''));
$apply = (string) ($_GET['apply'] ?? '0') === '1';
if (!preg_match('/^[A-Za-z0-9_-]{6,40}$/', $externalTournamentId)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_tournament_id']);
    exit;
}

$clean = static function (string $value): string {
    $value = html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string) preg_replace('/\s+/u', ' ', $value));
};

$fetch = static function (string $url): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 35,
        CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: nb-NO,nb;q=0.9,en-GB;q=0.8,en;q=0.7',
            'Cache-Control: no-cache',
            'Pragma: no-cache',
        ],
    ]);
    $body = curl_exec($ch);
    $error = $body === false ? curl_error($ch) : null;
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $effective = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);
    return ['status' => $status, 'body' => $body === false ? '' : (string) $body, 'error' => $error, 'effective_url' => $effective];
};

$parsePage = static function (array $response) use ($clean): array {
    $body = (string) ($response['body'] ?? '');
    $visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $body) ?? $body;
    $visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
    $visibleText = $clean($visible);
    $players = [];
    if (preg_match_all('~<a\b[^>]*href=["\']([^"\']*player_stats/([^"\'/?#]+)[^"\']*)["\'][^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $name = $clean((string) $row[3]);
            $name = trim((string) (preg_replace('/^Champion\s+/iu', '', $name) ?? $name));
            if ($name !== '') $players[(string) $row[2]] = $name;
        }
    }
    $matches = [];
    if (preg_match_all('~<a\b[^>]*href=["\'](?:https?://www\.dartsatlas\.com)?/matches/([A-Za-z0-9_-]+)["\'][^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $label = $clean((string) $row[2]);
            if ($label !== '') $matches[(string) $row[1]] = $label;
        }
    }
    return [
        'status' => (int) ($response['status'] ?? 0),
        'effective_url' => (string) ($response['effective_url'] ?? ''),
        'body_bytes' => strlen($body),
        'visible_text' => $visibleText,
        'players' => $players,
        'matches' => $matches,
        'curl_error' => $response['error'] ?? null,
    ];
};

$base = 'https://www.dartsatlas.com/tournaments/' . $externalTournamentId;
$urls = [
    'root' => $base,
    'group-1' => $base . '/group/1',
    'group-2' => $base . '/group/2',
    'results' => $base . '/results',
];
$pages = [];
foreach ($urls as $key => $url) {
    $pages[$key] = $parsePage($fetch($url));
    if ($pages[$key]['status'] !== 200) {
        http_response_code(502);
        echo json_encode(['ok' => false, 'error' => 'atlas_fetch_failed', 'page' => $key, 'details' => $pages[$key]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        exit;
    }
    usleep(450000);
}

$rootText = (string) $pages['root']['visible_text'];
$tournamentName = '';
if (preg_match('/^(.+?)\s+Sign Up\s+Sign In\b/u', $rootText, $m)) {
    $tournamentName = trim((string) $m[1]);
}
if ($tournamentName === '') {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'tournament_name_not_found']);
    exit;
}

$tournamentDate = null;
if (preg_match('/\b(20\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/u', $rootText, $m)) {
    $date = DateTimeImmutable::createFromFormat('!Y M j', $m[1] . ' ' . $m[2] . ' ' . $m[3], new DateTimeZone('Europe/Oslo'));
    if ($date instanceof DateTimeImmutable) $tournamentDate = $date->format('Y-m-d');
}
if ($tournamentDate === null) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'tournament_date_not_found']);
    exit;
}

$externalPlayers = [];
foreach ($pages as $page) {
    foreach ($page['players'] as $externalId => $name) $externalPlayers[$externalId] = $name;
}

$matchSources = [];
foreach (['group-1', 'group-2', 'results'] as $source) {
    foreach ($pages[$source]['matches'] as $externalId => $label) {
        $matchSources[$externalId] = ['label' => $label, 'source' => $source];
    }
}

$playerNames = array_values(array_unique(array_values($externalPlayers)));
usort($playerNames, static fn (string $a, string $b): int => mb_strlen($b) <=> mb_strlen($a));
$playerPattern = implode('|', array_map(static fn (string $name): string => preg_quote($name, '/'), $playerNames));

$parsedMatches = [];
$parseErrors = [];
foreach ($matchSources as $externalMatchId => $item) {
    $label = trim((string) $item['label']);
    if (!preg_match('/^(Round\s+(\d+)|Quarter-Final|Semi-Final|Final)\s+Best of\s+(\d+)\s+(.+)$/u', $label, $head)) {
        $parseErrors[$externalMatchId] = 'header:' . $label;
        continue;
    }
    $roundLabel = (string) $head[1];
    $roundNumber = isset($head[2]) && $head[2] !== '' ? (int) $head[2] : null;
    $bestOf = (int) $head[3];
    $tail = trim((string) $head[4]);
    $re = '/^(' . $playerPattern . ')\s+(\d+)\s+(' . $playerPattern . ')\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+Avg\s+([0-9]+(?:\.[0-9]+)?)\s+Avg$/u';
    if (!preg_match($re, $tail, $parts)) {
        $parseErrors[$externalMatchId] = 'players:' . $label;
        continue;
    }
    $scoreA = (int) $parts[2];
    $scoreB = (int) $parts[4];
    $parsedMatches[$externalMatchId] = [
        'external_id' => $externalMatchId,
        'source' => (string) $item['source'],
        'round_label' => $roundLabel,
        'round_number' => $roundNumber,
        'best_of_legs' => $bestOf,
        'legs_to_win' => intdiv($bestOf, 2) + 1,
        'player_a_name' => (string) $parts[1],
        'player_b_name' => (string) $parts[3],
        'player_a_legs' => $scoreA,
        'player_b_legs' => $scoreB,
        'player_a_average' => (float) $parts[5],
        'player_b_average' => (float) $parts[6],
        'winner_name' => $scoreA > $scoreB ? (string) $parts[1] : ($scoreB > $scoreA ? (string) $parts[3] : null),
    ];
}

$clubStmt = $db->prepare("SELECT id,name FROM `{$prefix}clubs` WHERE slug='blindleia-dartklubb' LIMIT 1");
$clubStmt->execute();
$club = $clubStmt->get_result()->fetch_assoc() ?: null;
$clubStmt->close();
if ($club === null) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'club_not_found']);
    exit;
}
$clubId = (int) $club['id'];

$seasonStmt = $db->prepare("SELECT id,name,starts_on,ends_on,is_active FROM `{$prefix}seasons` WHERE club_id=? AND (starts_on IS NULL OR starts_on<=?) AND (ends_on IS NULL OR ends_on>=?) ORDER BY is_active DESC,id DESC");
$seasonStmt->bind_param('iss', $clubId, $tournamentDate, $tournamentDate);
$seasonStmt->execute();
$seasonCandidates = $seasonStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$seasonStmt->close();
$season = null;
foreach ($seasonCandidates as $candidate) {
    if (stripos((string) $candidate['name'], 'Mandagsserien') !== false) {
        $season = $candidate;
        break;
    }
}
if ($season === null && count($seasonCandidates) === 1) $season = $seasonCandidates[0];
if ($season === null) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'season_not_resolved', 'candidates' => $seasonCandidates], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}
$seasonId = (int) $season['id'];

$externalRefTable = $prefix . 'external_references';
$playersTable = $prefix . 'players';
$playerMap = [];
$mappingErrors = [];
foreach ($externalPlayers as $externalId => $name) {
    $ref = $db->prepare("SELECT internal_id FROM `{$externalRefTable}` WHERE external_system='dartsatlas' AND external_entity_type='player' AND external_id=? AND internal_entity_type='player' LIMIT 1");
    $ref->bind_param('s', $externalId);
    $ref->execute();
    $refRow = $ref->get_result()->fetch_assoc() ?: null;
    $ref->close();
    if ($refRow !== null) {
        $internalId = (int) $refRow['internal_id'];
        $verify = $db->prepare("SELECT id,display_name FROM `{$playersTable}` WHERE id=? AND club_id=? LIMIT 1");
        $verify->bind_param('ii', $internalId, $clubId);
        $verify->execute();
        $row = $verify->get_result()->fetch_assoc() ?: null;
        $verify->close();
        if ($row !== null) {
            $playerMap[$name] = ['player_id' => $internalId, 'external_id' => $externalId, 'display_name' => (string) $row['display_name'], 'source' => 'external_reference'];
            continue;
        }
    }

    $byName = $db->prepare("SELECT id,display_name FROM `{$playersTable}` WHERE club_id=? AND TRIM(display_name)=? ORDER BY id ASC");
    $byName->bind_param('is', $clubId, $name);
    $byName->execute();
    $rows = $byName->get_result()->fetch_all(MYSQLI_ASSOC);
    $byName->close();
    if (count($rows) !== 1) {
        $mappingErrors[$externalId] = ['name' => $name, 'candidate_count' => count($rows), 'candidates' => $rows];
        continue;
    }
    $playerMap[$name] = ['player_id' => (int) $rows[0]['id'], 'external_id' => $externalId, 'display_name' => (string) $rows[0]['display_name'], 'source' => 'exact_name'];
}

$championName = null;
foreach ($playerNames as $name) {
    if (preg_match('/\bChampion\s+' . preg_quote($name, '/') . '\b/u', $rootText)) {
        $championName = $name;
        break;
    }
}

$tournamentRef = $db->prepare("SELECT internal_id FROM `{$externalRefTable}` WHERE external_system='dartsatlas' AND external_entity_type='tournament' AND external_id=? AND internal_entity_type='tournament' LIMIT 1");
$tournamentRef->bind_param('s', $externalTournamentId);
$tournamentRef->execute();
$tournamentRefRow = $tournamentRef->get_result()->fetch_assoc() ?: null;
$tournamentRef->close();
$existingTournament = null;
if ($tournamentRefRow !== null) {
    $id = (int) $tournamentRefRow['internal_id'];
    $stmt = $db->prepare("SELECT t.*, (SELECT COUNT(*) FROM `{$prefix}matches` m WHERE m.tournament_id=t.id) match_count FROM `{$prefix}tournaments` t WHERE t.id=? LIMIT 1");
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $existingTournament = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
} else {
    $stmt = $db->prepare("SELECT t.*, (SELECT COUNT(*) FROM `{$prefix}matches` m WHERE m.tournament_id=t.id) match_count FROM `{$prefix}tournaments` t WHERE t.club_id=? AND t.season_id=? AND t.name=? ORDER BY t.id DESC");
    $stmt->bind_param('iis', $clubId, $seasonId, $tournamentName);
    $stmt->execute();
    $candidates = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    if (count($candidates) === 1) $existingTournament = $candidates[0];
}

$blocking = [];
if ($mappingErrors !== []) $blocking[] = 'player_mapping';
if ($parseErrors !== []) $blocking[] = 'match_parsing';
if (count($parsedMatches) === 0) $blocking[] = 'no_matches';
if ($championName === null || !isset($playerMap[$championName])) $blocking[] = 'champion_mapping';
if ($existingTournament !== null && $tournamentRefRow === null && (int) ($existingTournament['match_count'] ?? 0) > 0) {
    $blocking[] = 'existing_nonimported_tournament_has_matches';
}

$groupPlayers = ['group-1' => [], 'group-2' => []];
foreach ($parsedMatches as $match) {
    if (isset($groupPlayers[$match['source']])) {
        $groupPlayers[$match['source']][$match['player_a_name']] = true;
        $groupPlayers[$match['source']][$match['player_b_name']] = true;
    }
}

$plan = [
    'tournament_external_id' => $externalTournamentId,
    'tournament_name' => $tournamentName,
    'tournament_date' => $tournamentDate,
    'club' => $club,
    'season' => $season,
    'champion' => $championName,
    'player_count' => count($externalPlayers),
    'mapped_player_count' => count($playerMap),
    'player_map' => $playerMap,
    'player_mapping_errors' => $mappingErrors,
    'match_count' => count($parsedMatches),
    'match_parse_errors' => $parseErrors,
    'groups' => [
        'Group 1' => array_keys($groupPlayers['group-1']),
        'Group 2' => array_keys($groupPlayers['group-2']),
    ],
    'existing_tournament' => $existingTournament ? ['id' => (int) $existingTournament['id'], 'status' => $existingTournament['status'], 'provider_system' => $existingTournament['provider_system'], 'match_count' => (int) $existingTournament['match_count']] : null,
    'blocking_errors' => $blocking,
];

if (!$apply) {
    echo json_encode(['ok' => $blocking === [], 'mode' => 'dry_run', 'plan' => $plan], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}
if ($blocking !== []) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'migration_blocked', 'plan' => $plan], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

$refUpsert = static function (mysqli $db, string $table, string $entityType, string $externalId, int $internalId): void {
    $sql = "INSERT INTO `{$table}` (external_system,external_entity_type,external_id,internal_entity_type,internal_id,sync_state,last_synced_at) VALUES ('dartsatlas',?,?,?,?,'synced',NOW()) ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),internal_id=VALUES(internal_id),sync_state='synced',last_synced_at=NOW()";
    $stmt = $db->prepare($sql);
    $stmt->bind_param('sssi', $entityType, $externalId, $entityType, $internalId);
    $stmt->execute();
    $stmt->close();
};

$db->begin_transaction();
try {
    foreach ($playerMap as $mapped) {
        $refUpsert($db, $externalRefTable, 'player', (string) $mapped['external_id'], (int) $mapped['player_id']);
    }

    if ($existingTournament !== null) {
        $tournamentId = (int) $existingTournament['id'];
        if ($tournamentRefRow === null) $refUpsert($db, $externalRefTable, 'tournament', $externalTournamentId, $tournamentId);
        $meta = json_encode(['source' => 'dartsatlas_migration', 'external_id' => $externalTournamentId, 'source_url' => $base, 'imported_at' => gmdate('c')], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $stmt = $db->prepare("UPDATE `{$prefix}tournaments` SET provider_metadata=?, status='completed', elo_enabled=1 WHERE id=?");
        $stmt->bind_param('si', $meta, $tournamentId);
        $stmt->execute();
        $stmt->close();
    } else {
        $slug = 'mandagsserien-' . strtolower(preg_replace('/[^0-9]+/', '-', $tournamentName) ?? '') . '-' . $tournamentDate;
        $slug = trim(preg_replace('/-+/', '-', $slug) ?? $slug, '-');
        $startAt = $tournamentDate . ' 18:30:00';
        $meta = json_encode(['source' => 'dartsatlas_migration', 'external_id' => $externalTournamentId, 'source_url' => $base, 'imported_at' => gmdate('c')], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $stmt = $db->prepare("INSERT INTO `{$prefix}tournaments` (club_id,season_id,name,slug,provider_system,provider_metadata,status,max_visits_per_leg,elo_enabled,start_at) VALUES (?,?,?,?,'local',?,'completed',50,1,?)");
        $stmt->bind_param('iissss', $clubId, $seasonId, $tournamentName, $slug, $meta, $startAt);
        $stmt->execute();
        $tournamentId = (int) $stmt->insert_id;
        $stmt->close();
        $refUpsert($db, $externalRefTable, 'tournament', $externalTournamentId, $tournamentId);
    }

    $registrationIds = [];
    foreach ($playerMap as $name => $mapped) {
        $playerId = (int) $mapped['player_id'];
        $stmt = $db->prepare("INSERT INTO `{$prefix}tournament_players` (tournament_id,player_id,status,registration_source) VALUES (?,?,'checked_in','import') ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)");
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $registrationId = (int) ($stmt->insert_id ?: $db->insert_id);
        $stmt->close();
        if ($registrationId <= 0) {
            $lookup = $db->prepare("SELECT id FROM `{$prefix}tournament_players` WHERE tournament_id=? AND player_id=? LIMIT 1");
            $lookup->bind_param('ii', $tournamentId, $playerId);
            $lookup->execute();
            $registrationId = (int) ($lookup->get_result()->fetch_assoc()['id'] ?? 0);
            $lookup->close();
        }
        $registrationIds[$name] = $registrationId;
    }

    $groupIds = [];
    $seedBase = (int) sprintf('%u', crc32($externalTournamentId));
    foreach ([1 => 'group-1', 2 => 'group-2'] as $sort => $source) {
        $groupName = 'Group ' . $sort;
        $stmt = $db->prepare("INSERT INTO `{$prefix}tournament_groups` (tournament_id,name,sort_order,draw_mode,draw_seed,generated_at) VALUES (?,?,?,'import',?,NOW()) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),name=VALUES(name)");
        $seed = $seedBase + $sort;
        $stmt->bind_param('isii', $tournamentId, $groupName, $sort, $seed);
        $stmt->execute();
        $groupId = (int) $stmt->insert_id;
        $stmt->close();
        if ($groupId <= 0) {
            $lookup = $db->prepare("SELECT id FROM `{$prefix}tournament_groups` WHERE tournament_id=? AND sort_order=? LIMIT 1");
            $lookup->bind_param('ii', $tournamentId, $sort);
            $lookup->execute();
            $groupId = (int) ($lookup->get_result()->fetch_assoc()['id'] ?? 0);
            $lookup->close();
        }
        $groupIds[$source] = $groupId;
        $position = 0;
        foreach (array_keys($groupPlayers[$source]) as $name) {
            $position++;
            $tpId = (int) $registrationIds[$name];
            $stmt = $db->prepare("INSERT INTO `{$prefix}tournament_group_players` (group_id,tournament_player_id,position) VALUES (?,?,?) ON DUPLICATE KEY UPDATE group_id=VALUES(group_id),position=VALUES(position)");
            $stmt->bind_param('iii', $groupId, $tpId, $position);
            $stmt->execute();
            $stmt->close();
        }
    }

    $matchInternalIds = [];
    $logicalOrder = [];
    $orderedMatches = array_values($parsedMatches);
    usort($orderedMatches, static function (array $a, array $b): int {
        $phase = static function (array $m): array {
            if (str_starts_with($m['source'], 'group-')) return [0, (int) ($m['round_number'] ?? 0), $m['source'], $m['external_id']];
            $rank = ['Quarter-Final' => 1, 'Semi-Final' => 2, 'Final' => 3];
            return [1, $rank[$m['round_label']] ?? 9, '', $m['external_id']];
        };
        return $phase($a) <=> $phase($b);
    });

    foreach ($orderedMatches as $match) {
        $externalMatchId = (string) $match['external_id'];
        $ref = $db->prepare("SELECT internal_id FROM `{$externalRefTable}` WHERE external_system='dartsatlas' AND external_entity_type='match' AND external_id=? AND internal_entity_type='match' LIMIT 1");
        $ref->bind_param('s', $externalMatchId);
        $ref->execute();
        $refRow = $ref->get_result()->fetch_assoc() ?: null;
        $ref->close();

        $playerA = (int) $playerMap[$match['player_a_name']]['player_id'];
        $playerB = (int) $playerMap[$match['player_b_name']]['player_id'];
        $winner = $match['winner_name'] !== null ? (int) $playerMap[$match['winner_name']]['player_id'] : null;
        $groupId = isset($groupIds[$match['source']]) ? (int) $groupIds[$match['source']] : null;
        $roundNumber = $match['round_number'];
        $bracketLabel = $groupId !== null ? ('Group ' . ($match['source'] === 'group-1' ? '1' : '2')) : 'Playoff';
        $providerMeta = json_encode(['source' => 'dartsatlas_migration', 'external_id' => $externalMatchId, 'source_label' => $matchSources[$externalMatchId]['label'] ?? null], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($refRow !== null) {
            $matchId = (int) $refRow['internal_id'];
            $stmt = $db->prepare("UPDATE `{$prefix}matches` SET tournament_group_id=?,round_label=?,round_number=?,bracket_label=?,provider_metadata=?,status='completed',best_of_legs=?,legs_to_win=?,player_a_id=?,player_b_id=?,winner_player_id=? WHERE id=? AND tournament_id=?");
            $stmt->bind_param('isissiiiiiii', $groupId, $match['round_label'], $roundNumber, $bracketLabel, $providerMeta, $match['best_of_legs'], $match['legs_to_win'], $playerA, $playerB, $winner, $matchId, $tournamentId);
            $stmt->execute();
            $stmt->close();
        } else {
            $stmt = $db->prepare("INSERT INTO `{$prefix}matches` (tournament_id,tournament_group_id,round_label,round_number,bracket_label,provider_metadata,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id) VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?)");
            $stmt->bind_param('iisissiiiiii', $tournamentId, $groupId, $match['round_label'], $roundNumber, $bracketLabel, $providerMeta, $match['best_of_legs'], $match['legs_to_win'], $playerA, $playerB, $winner);
            $stmt->execute();
            $matchId = (int) $stmt->insert_id;
            $stmt->close();
            $refUpsert($db, $externalRefTable, 'match', $externalMatchId, $matchId);
        }
        $matchInternalIds[$externalMatchId] = $matchId;
        $logicalOrder[] = $matchId;

        foreach ([
            [$playerA, (int) $match['player_a_legs'], (float) $match['player_a_average']],
            [$playerB, (int) $match['player_b_legs'], (float) $match['player_b_average']],
        ] as [$playerId, $legsWon, $average]) {
            $statMeta = json_encode(['source' => 'dartsatlas_migration', 'external_match_id' => $externalMatchId], JSON_UNESCAPED_SLASHES);
            $stmt = $db->prepare("INSERT INTO `{$prefix}match_statistics` (match_id,player_id,legs_won,average,provider_metadata) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE legs_won=VALUES(legs_won),average=VALUES(average),provider_metadata=VALUES(provider_metadata)");
            $stmt->bind_param('iiids', $matchId, $playerId, $legsWon, $average, $statMeta);
            $stmt->execute();
            $stmt->close();
        }
    }

    $championId = (int) $playerMap[$championName]['player_id'];
    $playoffStmt = $db->prepare("INSERT INTO `{$prefix}tournament_playoffs` (tournament_id,format,qualifiers_per_group,bracket_size,best_of_legs,status,champion_player_id) VALUES (?,'single_elimination',4,8,3,'completed',?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),status='completed',champion_player_id=VALUES(champion_player_id),best_of_legs=3");
    $playoffStmt->bind_param('ii', $tournamentId, $championId);
    $playoffStmt->execute();
    $playoffId = (int) $playoffStmt->insert_id;
    $playoffStmt->close();
    if ($playoffId <= 0) {
        $lookup = $db->prepare("SELECT id FROM `{$prefix}tournament_playoffs` WHERE tournament_id=? LIMIT 1");
        $lookup->bind_param('i', $tournamentId);
        $lookup->execute();
        $playoffId = (int) ($lookup->get_result()->fetch_assoc()['id'] ?? 0);
        $lookup->close();
    }

    $standings = [];
    foreach (['group-1', 'group-2'] as $source) {
        $stats = [];
        foreach (array_keys($groupPlayers[$source]) as $name) $stats[$name] = ['wins' => 0, 'losses' => 0, 'legs_won' => 0, 'legs_lost' => 0, 'avg_sum' => 0.0, 'avg_count' => 0];
        foreach ($parsedMatches as $m) {
            if ($m['source'] !== $source) continue;
            foreach ([['player_a_name','player_a_legs','player_b_legs','player_a_average'],['player_b_name','player_b_legs','player_a_legs','player_b_average']] as $fields) {
                $name = $m[$fields[0]];
                $stats[$name]['legs_won'] += (int) $m[$fields[1]];
                $stats[$name]['legs_lost'] += (int) $m[$fields[2]];
                $stats[$name]['avg_sum'] += (float) $m[$fields[3]];
                $stats[$name]['avg_count']++;
                if ($m['winner_name'] === $name) $stats[$name]['wins']++; else $stats[$name]['losses']++;
            }
        }
        $names = array_keys($stats);
        usort($names, static function (string $a, string $b) use ($stats): int {
            $sa = $stats[$a]; $sb = $stats[$b];
            $cmp = $sb['wins'] <=> $sa['wins'];
            if ($cmp !== 0) return $cmp;
            $cmp = (($sb['legs_won'] - $sb['legs_lost']) <=> ($sa['legs_won'] - $sa['legs_lost']));
            if ($cmp !== 0) return $cmp;
            $aa = $sa['avg_count'] ? $sa['avg_sum'] / $sa['avg_count'] : 0;
            $ab = $sb['avg_count'] ? $sb['avg_sum'] / $sb['avg_count'] : 0;
            return $ab <=> $aa;
        });
        foreach ($names as $index => $name) $standings[$name] = ['source' => $source, 'position' => $index + 1, 'stats' => $stats[$name]];
    }

    $qualifierNames = [];
    foreach ($standings as $name => $s) if ((int) $s['position'] <= 4) $qualifierNames[] = $name;
    $seed = 0;
    foreach ($qualifierNames as $name) {
        $seed++;
        $s = $standings[$name];
        $sourceGroupId = (int) $groupIds[$s['source']];
        $playerId = (int) $playerMap[$name]['player_id'];
        $points = (int) $s['stats']['wins'];
        $legDiff = (int) $s['stats']['legs_won'] - (int) $s['stats']['legs_lost'];
        $legsWon = (int) $s['stats']['legs_won'];
        $stmt = $db->prepare("INSERT INTO `{$prefix}tournament_playoff_entries` (playoff_id,player_id,seed_number,source_group_id,source_group_position,source_points,source_leg_diff,source_legs_won) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE source_group_id=VALUES(source_group_id),source_group_position=VALUES(source_group_position),source_points=VALUES(source_points),source_leg_diff=VALUES(source_leg_diff),source_legs_won=VALUES(source_legs_won)");
        $position = (int) $s['position'];
        $stmt->bind_param('iiiiiiii', $playoffId, $playerId, $seed, $sourceGroupId, $position, $points, $legDiff, $legsWon);
        $stmt->execute();
        $stmt->close();
    }

    $roundPosition = [1 => 0, 2 => 0, 3 => 0];
    foreach ($orderedMatches as $match) {
        if ($match['source'] !== 'results') continue;
        $playoffRound = ['Quarter-Final' => 1, 'Semi-Final' => 2, 'Final' => 3][$match['round_label']] ?? null;
        if ($playoffRound === null) continue;
        $roundPosition[$playoffRound]++;
        $position = $roundPosition[$playoffRound];
        $matchId = (int) $matchInternalIds[$match['external_id']];
        $playerA = (int) $playerMap[$match['player_a_name']]['player_id'];
        $playerB = (int) $playerMap[$match['player_b_name']]['player_id'];
        $winner = (int) $playerMap[$match['winner_name']]['player_id'];
        $stmt = $db->prepare("INSERT INTO `{$prefix}tournament_playoff_nodes` (playoff_id,round_number,position,round_label,player_a_id,player_b_id,match_id,winner_player_id,status) VALUES (?,?,?,?,?,?,?,?,'completed') ON DUPLICATE KEY UPDATE player_a_id=VALUES(player_a_id),player_b_id=VALUES(player_b_id),match_id=VALUES(match_id),winner_player_id=VALUES(winner_player_id),status='completed',round_label=VALUES(round_label)");
        $stmt->bind_param('iiisiiii', $playoffId, $playoffRound, $position, $match['round_label'], $playerA, $playerB, $matchId, $winner);
        $stmt->execute();
        $stmt->close();
    }

    $db->commit();
} catch (Throwable $error) {
    $db->rollback();
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'migration_write_failed', 'message' => $error->getMessage(), 'plan' => $plan], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

$eloApplied = 0;
$eloErrors = [];
try {
    $elo = new EloLedgerService($database);
    foreach ($logicalOrder as $matchId) {
        try {
            $elo->applyCompletedMatch((int) $matchId);
            $eloApplied++;
        } catch (Throwable $error) {
            $eloErrors[(string) $matchId] = $error->getMessage();
        }
    }
} catch (Throwable $error) {
    $eloErrors['service'] = $error->getMessage();
}

$verifyStmt = $db->prepare("SELECT t.id,t.name,t.status,COUNT(DISTINCT tp.id) participant_count,COUNT(DISTINCT m.id) match_count,COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) completed_match_count FROM `{$prefix}tournaments` t LEFT JOIN `{$prefix}tournament_players` tp ON tp.tournament_id=t.id LEFT JOIN `{$prefix}matches` m ON m.tournament_id=t.id WHERE t.id=? GROUP BY t.id,t.name,t.status");
$verifyStmt->bind_param('i', $tournamentId);
$verifyStmt->execute();
$verify = $verifyStmt->get_result()->fetch_assoc() ?: null;
$verifyStmt->close();

echo json_encode([
    'ok' => true,
    'mode' => 'applied',
    'tournament_id' => $tournamentId,
    'external_tournament_id' => $externalTournamentId,
    'verify' => $verify,
    'champion' => ['name' => $championName, 'player_id' => $championId],
    'match_external_map' => $matchInternalIds,
    'elo' => ['attempted' => count($logicalOrder), 'applied_or_already_applied' => $eloApplied, 'errors' => $eloErrors],
    'visits_imported' => false,
    'next_step' => 'Import legs/visits for each DartsAtlas match, then enrich match_statistics.',
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
