<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};

$prefix = $required('DB_TABLE_PREFIX');
if ($prefix !== 'bd_test_') throw new RuntimeException("Refusing Atlas manifest import outside bd_test_: {$prefix}");

$manifestPath = $argv[1] ?? '';
$sourcePath = $argv[2] ?? '';
if ($manifestPath === '' || !is_file($manifestPath) || $sourcePath === '' || !is_file($sourcePath)) {
    throw new RuntimeException('Usage: php import_atlas_manifest_test.php <manifest.json> <tournament-probe.json>');
}
$manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
$source = json_decode((string) file_get_contents($sourcePath), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($manifest) || !is_array($source)) throw new RuntimeException('Invalid Atlas manifest/source JSON.');

$tournamentExternalId = (string) ($manifest['tournament_external_id'] ?? '');
$seasonExternalId = (string) ($manifest['season_external_id'] ?? '');
if ($tournamentExternalId === '' || ($source['tournament_external_id'] ?? null) !== $tournamentExternalId) {
    throw new RuntimeException('Tournament source does not match manifest.');
}
$pages = is_array($source['pages'] ?? null) ? $source['pages'] : [];
$manifestPlayers = is_array($manifest['players'] ?? null) ? $manifest['players'] : [];
$groups = is_array($manifest['groups'] ?? null) ? $manifest['groups'] : [];
$playoffConfig = is_array($manifest['playoff'] ?? null) ? $manifest['playoff'] : [];
$expectedPlayers = (int) ($manifest['expected_players'] ?? 0);
$expectedMatches = (int) ($manifest['expected_matches'] ?? 0);
if ($expectedPlayers < 2 || count($manifestPlayers) !== $expectedPlayers || $expectedMatches < 1 || $groups === []) {
    throw new RuntimeException('Manifest counts/config are invalid.');
}

$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
};

$sourcePlayerNames = [];
$groupExternalOrder = [];
$expectedMatchIds = [];
foreach ($groups as $group) {
    $groupNumber = (int) ($group['number'] ?? 0);
    $pageName = 'group-' . $groupNumber;
    if ($groupNumber < 1 || !isset($pages[$pageName]) || (int) ($pages[$pageName]['status'] ?? 0) !== 200) {
        throw new RuntimeException("Missing successful source page {$pageName}");
    }
    $groupExternalOrder[$groupNumber] = array_values(array_map('strval', (array) ($group['players'] ?? [])));
    foreach ((array) ($pages[$pageName]['players'] ?? []) as $externalId => $name) {
        $sourcePlayerNames[(string) $externalId] = trim((string) $name);
    }
    foreach ((array) ($group['match_ids'] ?? []) as $externalId) $expectedMatchIds[(string) $externalId] = $pageName;
}
if (!isset($pages['results']) || (int) ($pages['results']['status'] ?? 0) !== 200) {
    throw new RuntimeException('Missing successful results page.');
}
foreach ((array) ($playoffConfig['match_ids'] ?? []) as $externalId) $expectedMatchIds[(string) $externalId] = 'results';
if (count($expectedMatchIds) !== $expectedMatches) throw new RuntimeException('Manifest match-id count differs from expected_matches.');

foreach ($manifestPlayers as $externalId => $name) {
    if (!isset($sourcePlayerNames[$externalId])) {
        throw new RuntimeException("Manifest player {$externalId} is missing from source group pages.");
    }
    if ($normalise((string) $sourcePlayerNames[$externalId]) !== $normalise((string) $name)) {
        throw new RuntimeException("Player name drift for {$externalId}: {$sourcePlayerNames[$externalId]} vs {$name}");
    }
}
if (count(array_intersect_key($sourcePlayerNames, $manifestPlayers)) !== $expectedPlayers) throw new RuntimeException('Source player count differs from manifest.');

$namePositions = [];
foreach ($manifestPlayers as $externalId => $name) $namePositions[(string) $externalId] = (string) $name;
$parseMatch = static function (string $externalId, string $label, string $sourcePage, ?int $groupNumber) use ($namePositions): array {
    $label = trim((string) preg_replace('/\s+/u', ' ', $label));
    if (!preg_match('/\bBest\s+of\s+(\d+)\b/i', $label, $best)) throw new RuntimeException("Missing Best of for {$externalId}: {$label}");
    $bestOf = (int) $best[1];
    $legsToWin = intdiv($bestOf, 2) + 1;
    $roundLabel = null; $roundNumber = null;
    if (preg_match('/\bRound\s+(\d+)\b/i', $label, $round)) {
        $roundNumber = (int) $round[1]; $roundLabel = 'Round ' . $roundNumber;
    } elseif (preg_match('/\b(Quarter-Final|Semi-Final|Final)\b/i', $label, $round)) {
        $x = strtolower((string) $round[1]);
        $roundLabel = $x === 'quarter-final' ? 'Quarter-Final' : ($x === 'semi-final' ? 'Semi-Final' : 'Final');
    }
    $positions = [];
    foreach ($namePositions as $pid => $name) {
        $pos = mb_stripos($label, $name, 0, 'UTF-8');
        if ($pos !== false) $positions[] = ['pos' => $pos, 'external_id' => $pid, 'name' => $name];
    }
    usort($positions, static fn(array $a, array $b): int => $a['pos'] <=> $b['pos']);
    if (count($positions) !== 2) throw new RuntimeException("Could not resolve exactly two players for {$externalId}: {$label}");
    $a = $positions[0]; $b = $positions[1];
    $aEnd = $a['pos'] + mb_strlen($a['name'], 'UTF-8');
    $between = mb_substr($label, $aEnd, $b['pos'] - $aEnd, 'UTF-8');
    $afterB = mb_substr($label, $b['pos'] + mb_strlen($b['name'], 'UTF-8'), null, 'UTF-8');
    if (!preg_match('/\b(\d{1,2})\b/u', $between, $sa) || !preg_match('/^\s*(\d{1,2})\b/u', $afterB, $sb)) {
        throw new RuntimeException("Could not parse score for {$externalId}: {$label}");
    }
    $scoreA = (int) $sa[1]; $scoreB = (int) $sb[1];
    if ($scoreA === $scoreB || max($scoreA, $scoreB) < $legsToWin) throw new RuntimeException("Undecided result {$externalId}: {$label}");
    preg_match_all('/\b(\d{1,3}(?:\.\d{1,2})?)\s*Avg\b/i', $label, $averages);
    $averageA = isset($averages[1][0]) ? (float) $averages[1][0] : null;
    $averageB = isset($averages[1][1]) ? (float) $averages[1][1] : null;
    if ($averageA === null || $averageB === null) throw new RuntimeException("Missing averages for {$externalId}");
    $winnerExternalId = $scoreA > $scoreB ? $a['external_id'] : $b['external_id'];
    $stageOrder = $groupNumber !== null ? (($roundNumber ?? 0) * 10 + $groupNumber) : match ($roundLabel) {
        'Quarter-Final' => 100, 'Semi-Final' => 110, 'Final' => 120, default => 130,
    };
    return [
        'external_id' => $externalId, 'source_page' => $sourcePage, 'group_number' => $groupNumber,
        'round_label' => $roundLabel, 'round_number' => $roundNumber, 'best_of_legs' => $bestOf,
        'legs_to_win' => $legsToWin, 'player_a_external_id' => $a['external_id'],
        'player_b_external_id' => $b['external_id'], 'score_a' => $scoreA, 'score_b' => $scoreB,
        'winner_external_id' => $winnerExternalId, 'average_a' => $averageA, 'average_b' => $averageB,
        'raw_label' => $label, 'stage_order' => $stageOrder,
    ];
};

$matches = []; $playoffMatches = [];
foreach ($expectedMatchIds as $externalId => $pageName) {
    $label = (string) ($pages[$pageName]['matches'][$externalId] ?? '');
    if ($label === '') throw new RuntimeException("Expected Atlas match {$externalId} missing from {$pageName}");
    $groupNumber = str_starts_with($pageName, 'group-') ? (int) substr($pageName, 6) : null;
    $match = $parseMatch($externalId, $label, $pageName, $groupNumber);
    $matches[$externalId] = $match;
    if ($groupNumber === null) $playoffMatches[] = $match;
}
foreach ($pages as $pageName => $page) {
    if (!isset($page['matches']) || (!str_starts_with((string) $pageName, 'group-') && $pageName !== 'results')) continue;
    foreach (array_keys((array) $page['matches']) as $externalId) {
        if (isset($manifestPlayers[(string) $externalId])) continue;
        if (isset($expectedMatchIds[(string) $externalId])) continue;
        if ($pageName === 'results' || isset($groupExternalOrder[(int) str_replace('group-', '', (string) $pageName)])) {
            throw new RuntimeException("Source drift: unexpected match {$externalId} on {$pageName}");
        }
    }
}
if (count($matches) !== $expectedMatches) throw new RuntimeException('Parsed match count differs from manifest.');
$final = null;
foreach ($playoffMatches as $match) if ($match['round_label'] === 'Final') $final = $match;
if ($final === null) throw new RuntimeException('Final not found.');
$championExternalId = (string) ($playoffConfig['champion_external_id'] ?? '');
if ($championExternalId === '' || $final['winner_external_id'] !== $championExternalId) throw new RuntimeException('Champion differs from frozen manifest.');

$db = new mysqli($required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'), $required('DB_NAME'), (int) $required('DB_PORT'));
$db->set_charset('utf8mb4');
$externalSystem = 'dartsatlas';
$tournamentName = (string) $manifest['tournament_name'];
$tournamentSlug = (string) $manifest['tournament_slug'];
$tournamentDate = (string) $manifest['tournament_date'];
$tournamentStartAt = (string) $manifest['tournament_start_at'];
$seasonName = (string) $manifest['season_name'];
$seasonStartsOn = (string) $manifest['season_starts_on'];
$seasonEndsOn = (string) $manifest['season_ends_on'];

$db->begin_transaction();
try {
    $club = $db->query("SELECT id FROM `{$prefix}clubs` WHERE slug='blindleia-dartklubb' LIMIT 1")->fetch_assoc();
    if ($club === null) throw new RuntimeException('Blindleia TEST club not found.');
    $clubId = (int) $club['id'];

    $allRows = $db->query("SELECT id,display_name,member_id,is_active FROM `{$prefix}players` WHERE club_id={$clubId} OR club_id IS NULL ORDER BY id")->fetch_all(MYSQLI_ASSOC);
    $byName = [];
    foreach ($allRows as $row) $byName[$normalise((string) $row['display_name'])][] = $row;
    $localPlayers = []; $duplicates = [];
    foreach ($manifestPlayers as $externalId => $displayName) {
        $candidates = $byName[$normalise((string) $displayName)] ?? [];
        if ($candidates === []) {
            $active = 1;
            $stmt = $db->prepare("INSERT INTO `{$prefix}players` (club_id,display_name,is_active,member_link_source) VALUES (?,?,?,'dartsatlas_import')");
            $stmt->bind_param('isi', $clubId, $displayName, $active); $stmt->execute();
            $localId = (int) $stmt->insert_id; $stmt->close();
        } else {
            usort($candidates, static function (array $a, array $b): int {
                $linked = ($b['member_id'] !== null ? 1 : 0) <=> ($a['member_id'] !== null ? 1 : 0);
                if ($linked !== 0) return $linked;
                $active = (int) $b['is_active'] <=> (int) $a['is_active'];
                return $active !== 0 ? $active : ((int) $a['id'] <=> (int) $b['id']);
            });
            $localId = (int) $candidates[0]['id'];
            if (count($candidates) > 1) $duplicates[$displayName] = count($candidates);
        }
        $localPlayers[$externalId] = $localId;
    }

    $refUpsert = $db->prepare("INSERT INTO `{$prefix}external_references` (external_system,external_entity_type,external_id,internal_entity_type,internal_id,sync_state,last_synced_at) VALUES (?,?,?,?,?,'synced',NOW()) ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),internal_id=VALUES(internal_id),sync_state='synced',last_synced_at=NOW()");
    $putRef = static function (string $type, string $externalId, string $internalType, int $internalId) use ($refUpsert, $externalSystem): void {
        $refUpsert->bind_param('ssssi', $externalSystem, $type, $externalId, $internalType, $internalId); $refUpsert->execute();
    };
    foreach ($localPlayers as $externalId => $localId) $putRef('player', $externalId, 'player', $localId);

    $findRef = $db->prepare("SELECT internal_id FROM `{$prefix}external_references` WHERE external_system=? AND external_entity_type=? AND external_id=? LIMIT 1");
    $type = 'season'; $findRef->bind_param('sss', $externalSystem, $type, $seasonExternalId); $findRef->execute();
    $row = $findRef->get_result()->fetch_assoc(); $seasonId = $row ? (int) $row['internal_id'] : null;
    if ($seasonId === null) {
        $stmt = $db->prepare("SELECT id FROM `{$prefix}seasons` WHERE club_id=? AND name=? LIMIT 1"); $stmt->bind_param('is', $clubId, $seasonName); $stmt->execute();
        $r = $stmt->get_result()->fetch_assoc(); $stmt->close(); if ($r) $seasonId = (int) $r['id'];
    }
    if ($seasonId === null) {
        $active=1; $status='active'; $ranking='linear';
        $stmt=$db->prepare("INSERT INTO `{$prefix}seasons` (club_id,name,starts_on,ends_on,is_active,status,ranking_method) VALUES (?,?,?,?,?,?,?)");
        $stmt->bind_param('isssiss',$clubId,$seasonName,$seasonStartsOn,$seasonEndsOn,$active,$status,$ranking); $stmt->execute(); $seasonId=(int)$stmt->insert_id; $stmt->close();
    } else {
        $stmt=$db->prepare("UPDATE `{$prefix}seasons` SET name=?,starts_on=?,ends_on=?,is_active=1,status='active',ranking_method='linear' WHERE id=?");
        $stmt->bind_param('sssi',$seasonName,$seasonStartsOn,$seasonEndsOn,$seasonId); $stmt->execute(); $stmt->close();
    }
    $putRef('season',$seasonExternalId,'season',$seasonId);

    $type='tournament'; $findRef->bind_param('sss',$externalSystem,$type,$tournamentExternalId); $findRef->execute();
    $row=$findRef->get_result()->fetch_assoc(); $tournamentId=$row ? (int)$row['internal_id'] : null;
    if ($tournamentId === null) {
        $stmt=$db->prepare("SELECT id FROM `{$prefix}tournaments` WHERE club_id=? AND name=? AND DATE(start_at)=? LIMIT 1");
        $stmt->bind_param('iss',$clubId,$tournamentName,$tournamentDate); $stmt->execute(); $r=$stmt->get_result()->fetch_assoc(); $stmt->close(); if($r)$tournamentId=(int)$r['id'];
    }
    $metadata=json_encode(['source'=>'dartsatlas_history_import','external_id'=>$tournamentExternalId,'external_season_id'=>$seasonExternalId,'source_url'=>'https://www.dartsatlas.com/tournaments/'.$tournamentExternalId,'source_date'=>$tournamentDate,'manifest'=>basename($manifestPath),'completeness'=>['matches'=>'complete','match_averages'=>'complete','legs'=>'pending','visits'=>'pending']],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
    $alreadyFinal=false;
    if($tournamentId!==null){$r=$db->query("SELECT status,end_at FROM `{$prefix}tournaments` WHERE id={$tournamentId}")->fetch_assoc();$alreadyFinal=$r && $r['status']==='completed' && !empty($r['end_at']);}
    if($tournamentId===null){
        $stmt=$db->prepare("INSERT INTO `{$prefix}tournaments` (club_id,season_id,name,slug,provider_system,provider_metadata,status,start_at,elo_enabled) VALUES (?,?,?,?,'historical_import',?,'in_progress',?,1)");
        $stmt->bind_param('iissss',$clubId,$seasonId,$tournamentName,$tournamentSlug,$metadata,$tournamentStartAt);$stmt->execute();$tournamentId=(int)$stmt->insert_id;$stmt->close();
    }else{
        $status=$alreadyFinal?'completed':'in_progress';
        $stmt=$db->prepare("UPDATE `{$prefix}tournaments` SET club_id=?,season_id=?,name=?,slug=?,provider_system='historical_import',provider_metadata=?,status=?,start_at=?,elo_enabled=1 WHERE id=?");
        $stmt->bind_param('iisssssi',$clubId,$seasonId,$tournamentName,$tournamentSlug,$metadata,$status,$tournamentStartAt,$tournamentId);$stmt->execute();$stmt->close();
    }
    $putRef('tournament',$tournamentExternalId,'tournament',$tournamentId);

    $registration=$db->prepare("INSERT INTO `{$prefix}tournament_players` (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source) VALUES (?,?,'checked_in','legacy',?,'legacy') ON DUPLICATE KEY UPDATE registration_source='legacy',checked_in_at=COALESCE(checked_in_at,VALUES(checked_in_at)),checkin_source='legacy'");
    foreach($localPlayers as $localId){$registration->bind_param('iis',$tournamentId,$localId,$tournamentStartAt);$registration->execute();}$registration->close();

    $groupIds=[];$groupPositions=[];
    foreach($groups as $group){
        $n=(int)$group['number'];$name=(string)($group['name']??('Group '.$n));
        $stmt=$db->prepare("SELECT id FROM `{$prefix}tournament_groups` WHERE tournament_id=? AND sort_order=? LIMIT 1");$stmt->bind_param('ii',$tournamentId,$n);$stmt->execute();$r=$stmt->get_result()->fetch_assoc();$stmt->close();
        if(!$r){$mode='historical_import';$seed=0;$stmt=$db->prepare("INSERT INTO `{$prefix}tournament_groups` (tournament_id,name,sort_order,draw_mode,draw_seed,generated_at) VALUES (?,?,?,?,?,?)");$stmt->bind_param('isisis',$tournamentId,$name,$n,$mode,$seed,$tournamentStartAt);$stmt->execute();$gid=(int)$stmt->insert_id;$stmt->close();}
        else{$gid=(int)$r['id'];$stmt=$db->prepare("UPDATE `{$prefix}tournament_groups` SET name=?,draw_mode='historical_import',draw_seed=0 WHERE id=?");$stmt->bind_param('si',$name,$gid);$stmt->execute();$stmt->close();}
        $groupIds[$n]=$gid;$db->query("DELETE FROM `{$prefix}tournament_group_players` WHERE group_id={$gid}");
        $ins=$db->prepare("INSERT INTO `{$prefix}tournament_group_players` (group_id,tournament_player_id,position,seed_number,seed_rating,seed_rating_source) SELECT ?,tp.id,?,NULL,NULL,'dartsatlas_import' FROM `{$prefix}tournament_players` tp WHERE tp.tournament_id=? AND tp.player_id=? LIMIT 1");
        foreach($groupExternalOrder[$n] as $index=>$eid){$pos=$index+1;$pid=$localPlayers[$eid];$ins->bind_param('iiii',$gid,$pos,$tournamentId,$pid);$ins->execute();if($ins->affected_rows!==1)throw new RuntimeException("Could not assign {$eid} to group {$n}");$groupPositions[$eid]=['group_id'=>$gid,'position'=>$pos];}$ins->close();
    }

    $ordered=array_values($matches);usort($ordered,static fn(array $a,array $b):int=>($a['stage_order']<=>$b['stage_order'])?:strcmp($a['external_id'],$b['external_id']));
    $matchLocalIds=[];$order=0;
    foreach($ordered as $match){
        $order++;$pa=$localPlayers[$match['player_a_external_id']];$pb=$localPlayers[$match['player_b_external_id']];$winner=$localPlayers[$match['winner_external_id']];$gid=$match['group_number']!==null?$groupIds[$match['group_number']]:null;$bracket=$match['group_number']!==null?'group':'single_elimination';
        $mmeta=json_encode(['source'=>'dartsatlas_history_import','external_id'=>$match['external_id'],'source_page'=>$match['source_page'],'source_label'=>$match['raw_label'],'source_scores'=>[$match['score_a'],$match['score_b']],'import_order'=>$order,'completeness'=>'aggregate_result_and_average'],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        $type='match';$eid=$match['external_id'];$findRef->bind_param('sss',$externalSystem,$type,$eid);$findRef->execute();$rr=$findRef->get_result()->fetch_assoc();$mid=$rr?(int)$rr['internal_id']:null;
        $rl=$match['round_label'];$rn=$match['round_number'];$bo=$match['best_of_legs'];$ltw=$match['legs_to_win'];
        if($mid===null){$stmt=$db->prepare("INSERT INTO `{$prefix}matches` (tournament_id,tournament_group_id,round_label,round_number,bracket_label,provider_metadata,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,finished_at) VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?,?)");$stmt->bind_param('iisissiiiiis',$tournamentId,$gid,$rl,$rn,$bracket,$mmeta,$bo,$ltw,$pa,$pb,$winner,$tournamentStartAt);$stmt->execute();$mid=(int)$stmt->insert_id;$stmt->close();}
        else{$stmt=$db->prepare("UPDATE `{$prefix}matches` SET tournament_id=?,tournament_group_id=?,round_label=?,round_number=?,bracket_label=?,provider_metadata=?,status='completed',best_of_legs=?,legs_to_win=?,player_a_id=?,player_b_id=?,winner_player_id=?,finished_at=? WHERE id=?");$stmt->bind_param('iisissiiiiisi',$tournamentId,$gid,$rl,$rn,$bracket,$mmeta,$bo,$ltw,$pa,$pb,$winner,$tournamentStartAt,$mid);$stmt->execute();$stmt->close();}
        $putRef('match',$eid,'match',$mid);$matchLocalIds[$eid]=$mid;
        $stats=$db->prepare("INSERT INTO `{$prefix}match_statistics` (match_id,player_id,legs_won,average,provider_metadata) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE legs_won=VALUES(legs_won),average=VALUES(average),provider_metadata=VALUES(provider_metadata),updated_at=NOW()");$smeta=json_encode(['source'=>'dartsatlas_history_import','external_match_id'=>$eid],JSON_UNESCAPED_SLASHES);$sa=$match['score_a'];$sb=$match['score_b'];$aa=$match['average_a'];$ab=$match['average_b'];$stats->bind_param('iiids',$mid,$pa,$sa,$aa,$smeta);$stats->execute();$stats->bind_param('iiids',$mid,$pb,$sb,$ab,$smeta);$stats->execute();$stats->close();
    }

    $stmt=$db->prepare("SELECT id FROM `{$prefix}tournament_playoffs` WHERE tournament_id=? LIMIT 1");$stmt->bind_param('i',$tournamentId);$stmt->execute();$r=$stmt->get_result()->fetch_assoc();$stmt->close();if($r){$old=(int)$r['id'];$db->query("DELETE FROM `{$prefix}tournament_playoff_nodes` WHERE playoff_id={$old}");$db->query("DELETE FROM `{$prefix}tournament_playoff_entries` WHERE playoff_id={$old}");$db->query("DELETE FROM `{$prefix}tournament_playoffs` WHERE id={$old}");}
    $championId=$localPlayers[$championExternalId];$qpg=(int)$playoffConfig['qualifiers_per_group'];$bracketSize=(int)$playoffConfig['bracket_size'];$playoffBest=(int)$playoffConfig['best_of_legs'];
    $stmt=$db->prepare("INSERT INTO `{$prefix}tournament_playoffs` (tournament_id,format,qualifiers_per_group,bracket_size,best_of_legs,status,champion_player_id) VALUES (?,'single_elimination',?,?,?,'completed',?)");$stmt->bind_param('iiiii',$tournamentId,$qpg,$bracketSize,$playoffBest,$championId);$stmt->execute();$playoffId=(int)$stmt->insert_id;$stmt->close();
    $entry=$db->prepare("INSERT INTO `{$prefix}tournament_playoff_entries` (playoff_id,player_id,seed_number,source_group_id,source_group_position,source_points,source_leg_diff,source_legs_won) VALUES (?,?,?,?,?,0,0,0)");foreach((array)$playoffConfig['qualifiers'] as $index=>$eid){$seed=$index+1;$pid=$localPlayers[$eid];$src=$groupPositions[$eid];$entry->bind_param('iiiii',$playoffId,$pid,$seed,$src['group_id'],$src['position']);$entry->execute();}$entry->close();
    $node=$db->prepare("INSERT INTO `{$prefix}tournament_playoff_nodes` (playoff_id,round_number,position,round_label,player_a_id,player_b_id,match_id,winner_player_id,status) VALUES (?,?,?,?,?,?,?,?,'completed')");$posByRound=[];
    foreach($playoffMatches as $match){$stage=$match['round_label'];$nodeRound=$bracketSize<=4?match($stage){'Semi-Final'=>1,'Final'=>2,default=>0}:match($stage){'Quarter-Final'=>1,'Semi-Final'=>2,'Final'=>3,default=>0};if($nodeRound===0)continue;$position=($posByRound[$nodeRound]??0)+1;$posByRound[$nodeRound]=$position;$pa=$localPlayers[$match['player_a_external_id']];$pb=$localPlayers[$match['player_b_external_id']];$mid=$matchLocalIds[$match['external_id']];$winner=$localPlayers[$match['winner_external_id']];$node->bind_param('iiisiiii',$playoffId,$nodeRound,$position,$stage,$pa,$pb,$mid,$winner);$node->execute();}$node->close();

    $points=(array)($manifest['ranking_points']??[]);$stages=(array)($manifest['ranking_stages']??[]);if(count($points)!==$expectedPlayers)throw new RuntimeException('Ranking manifest incomplete.');
    $rank=$db->prepare("INSERT INTO `{$prefix}season_ranking_events` (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,source_reference,status,metadata_json,applied_at) VALUES (?,?,?,?,?,?,?,'linear_v1','dartsatlas_import',?,'applied',?,?) ON DUPLICATE KEY UPDATE season_id=VALUES(season_id),entrants=VALUES(entrants),stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),points=VALUES(points),source='dartsatlas_import',status='applied',metadata_json=VALUES(metadata_json),reverted_at=NULL,applied_at=VALUES(applied_at)");
    foreach($points as $eid=>$pointValue){$pid=$localPlayers[$eid];$stage=(string)($stages[$eid]??'Group stage');$stageNumber=(int)$pointValue;$pointsFloat=(float)$pointValue;$sourceRef=$tournamentExternalId.':'.$eid;$rmeta=json_encode(['source'=>'dartsatlas_history_import','external_player_id'=>$eid],JSON_UNESCAPED_SLASHES);$rank->bind_param('iiiisidsss',$seasonId,$tournamentId,$pid,$expectedPlayers,$stage,$stageNumber,$pointsFloat,$sourceRef,$rmeta,$tournamentStartAt);$rank->execute();}$rank->close();

    $findRef->close();$refUpsert->close();$db->commit();
    $counts=[];foreach(['players'=>"SELECT COUNT(*) c FROM `{$prefix}tournament_players` WHERE tournament_id={$tournamentId}",'groups'=>"SELECT COUNT(*) c FROM `{$prefix}tournament_groups` WHERE tournament_id={$tournamentId}",'matches'=>"SELECT COUNT(*) c FROM `{$prefix}matches` WHERE tournament_id={$tournamentId}",'ranking_events'=>"SELECT COUNT(*) c FROM `{$prefix}season_ranking_events` WHERE tournament_id={$tournamentId} AND status='applied'",'playoff_nodes'=>"SELECT COUNT(*) c FROM `{$prefix}tournament_playoff_nodes` n JOIN `{$prefix}tournament_playoffs` p ON p.id=n.playoff_id WHERE p.tournament_id={$tournamentId}"] as $label=>$sql)$counts[$label]=(int)($db->query($sql)->fetch_assoc()['c']??0);
    echo 'ATLAS_MANIFEST_IMPORT_OK=yes'.PHP_EOL.'tournament_id='.$tournamentId.PHP_EOL.'champion='.$manifestPlayers[$championExternalId].PHP_EOL.'duplicates_resolved='.json_encode($duplicates,JSON_UNESCAPED_UNICODE).PHP_EOL.'counts='.json_encode($counts).PHP_EOL;
} catch(Throwable $e){$db->rollback();throw $e;} finally {$db->close();}
