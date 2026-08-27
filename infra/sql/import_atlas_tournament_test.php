<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};
$prefix = $required('DB_TABLE_PREFIX');
if ($prefix !== 'bd_test_') throw new RuntimeException("Refusing Atlas tournament import outside bd_test_: {$prefix}");

$manifestPath = $argv[1] ?? '';
$sourcePath = $argv[2] ?? '';
if ($manifestPath === '' || !is_file($manifestPath) || $sourcePath === '' || !is_file($sourcePath)) {
    throw new RuntimeException('Usage: php import_atlas_tournament_test.php <manifest-json> <tournament-probe-json>');
}
$manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
$source = json_decode((string) file_get_contents($sourcePath), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($manifest) || !is_array($source)) throw new RuntimeException('Invalid manifest/source JSON.');

$seasonExternalId = trim((string) ($manifest['season_external_id'] ?? ''));
$seasonName = trim((string) ($manifest['season_name'] ?? ''));
$seasonStartsOn = trim((string) ($manifest['season_starts_on'] ?? ''));
$seasonEndsOn = trim((string) ($manifest['season_ends_on'] ?? ''));
$tournamentExternalId = trim((string) ($manifest['tournament_external_id'] ?? ''));
$tournamentName = trim((string) ($manifest['tournament_name'] ?? ''));
$tournamentDate = trim((string) ($manifest['tournament_date'] ?? ''));
$tournamentStartAt = trim((string) ($manifest['tournament_start_at'] ?? ''));
$slug = trim((string) ($manifest['slug'] ?? ''));
$expectedPlayers = (int) ($manifest['expected_players'] ?? 0);
$expectedMatches = (int) ($manifest['expected_matches'] ?? 0);
$manifestPlayers = (array) ($manifest['players'] ?? []);
$manifestMatchIds = array_values(array_map('strval', (array) ($manifest['match_external_ids'] ?? [])));
$groupConfigs = array_values((array) ($manifest['groups'] ?? []));
$playoffConfig = (array) ($manifest['playoff'] ?? []);
$championExternalId = trim((string) ($playoffConfig['champion_external_id'] ?? ''));

foreach ([
    'season_external_id'=>$seasonExternalId,'season_name'=>$seasonName,'season_starts_on'=>$seasonStartsOn,'season_ends_on'=>$seasonEndsOn,
    'tournament_external_id'=>$tournamentExternalId,'tournament_name'=>$tournamentName,'tournament_date'=>$tournamentDate,
    'tournament_start_at'=>$tournamentStartAt,'slug'=>$slug,'champion_external_id'=>$championExternalId,
] as $field=>$value) if ($value === '') throw new RuntimeException("Manifest missing {$field}.");
if ($expectedPlayers < 2 || count($manifestPlayers) !== $expectedPlayers) throw new RuntimeException('Manifest player count is inconsistent.');
if ($expectedMatches < 1 || count($manifestMatchIds) !== $expectedMatches || count(array_unique($manifestMatchIds)) !== $expectedMatches) throw new RuntimeException('Manifest match count is inconsistent.');
if (($source['tournament_external_id'] ?? '') !== $tournamentExternalId) throw new RuntimeException('Source tournament does not match manifest.');
if (!is_array($source['pages'] ?? null)) throw new RuntimeException('Source probe has no pages.');

$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
};

// Freeze and validate group membership/order directly from the probed pages.
$groupExternalOrder = [];
$seenPlayers = [];
foreach ($groupConfigs as $cfg) {
    $number = (int) ($cfg['number'] ?? 0);
    $pageName = trim((string) ($cfg['page'] ?? ''));
    $size = (int) ($cfg['size'] ?? 0);
    $page = $source['pages'][$pageName] ?? null;
    if ($number < 1 || $pageName === '' || $size < 2 || !is_array($page) || (int) ($page['status'] ?? 0) !== 200) {
        throw new RuntimeException("Invalid/missing group source {$pageName}.");
    }
    $pagePlayers = (array) ($page['players'] ?? []);
    $order = [];
    foreach ($pagePlayers as $externalId => $name) {
        if (!array_key_exists((string) $externalId, $manifestPlayers)) continue;
        if ($normalise((string) $name) !== $normalise((string) $manifestPlayers[(string) $externalId])) {
            throw new RuntimeException("Player name mismatch for {$externalId} on {$pageName}.");
        }
        $order[] = (string) $externalId;
        $seenPlayers[(string) $externalId] = true;
    }
    if (count($order) !== $size) throw new RuntimeException("Group {$number} expected {$size} players, got " . count($order));
    $groupExternalOrder[$number] = $order;
}
if (count($seenPlayers) !== $expectedPlayers) throw new RuntimeException('Not every manifest player appears in a frozen group.');

$playerNamesByLength = $manifestPlayers;
uasort($playerNamesByLength, static fn(string $a, string $b): int => mb_strlen($b) <=> mb_strlen($a));
$parseMatch = static function (string $externalId, string $label, ?int $groupNumber, string $sourcePage) use ($playerNamesByLength, $manifestPlayers): array {
    $matched = null;
    foreach ($playerNamesByLength as $aId => $aName) {
        foreach ($playerNamesByLength as $bId => $bName) {
            if ($aId === $bId) continue;
            $pattern = '~^(.*?)' . preg_quote((string) $aName, '~') . '\s+(\d+)\s+' . preg_quote((string) $bName, '~') . '\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+Avg\s+([0-9]+(?:\.[0-9]+)?)\s+Avg\s*$~iu';
            if (!preg_match($pattern, trim($label), $m)) continue;
            $matched = ['prefix'=>trim((string)$m[1]),'a'=>(string)$aId,'b'=>(string)$bId,'score_a'=>(int)$m[2],'score_b'=>(int)$m[3],'avg_a'=>(float)$m[4],'avg_b'=>(float)$m[5]];
            break 2;
        }
    }
    if ($matched === null) throw new RuntimeException("Could not parse Atlas match {$externalId}: {$label}");
    if ($matched['score_a'] === $matched['score_b']) throw new RuntimeException("Atlas match {$externalId} is tied/undecided.");
    $winner = $matched['score_a'] > $matched['score_b'] ? $matched['a'] : $matched['b'];
    if (!isset($manifestPlayers[$winner])) throw new RuntimeException("Unknown winner in {$externalId}");
    $bestOf = 1;
    if (preg_match('/Best of\s+(\d+)/iu', $matched['prefix'], $m)) $bestOf = max(1, (int) $m[1]);
    $legsToWin = intdiv($bestOf, 2) + 1;
    $roundLabel = $groupNumber !== null ? 'Round ' . (($matched['prefix'] && preg_match('/Round\s+(\d+)/iu', $matched['prefix'], $m)) ? (int)$m[1] : 0) : '';
    $roundNumber = 0;
    $stageOrder = 0;
    if ($groupNumber !== null) {
        if (!preg_match('/Round\s+(\d+)/iu', $matched['prefix'], $m)) throw new RuntimeException("Missing group round for {$externalId}");
        $roundNumber = (int) $m[1];
        $roundLabel = 'Round ' . $roundNumber;
        $stageOrder = $roundNumber;
    } else {
        foreach (['Round of 16','Quarter-Final','Semi-Final','Final'] as $candidate) {
            if (stripos($matched['prefix'], $candidate) !== false) {$roundLabel=$candidate;break;}
        }
        if ($roundLabel === '') throw new RuntimeException("Unknown playoff round for {$externalId}: {$matched['prefix']}");
        $stageOrder = match ($roundLabel) {'Round of 16'=>100,'Quarter-Final'=>200,'Semi-Final'=>300,'Final'=>400};
    }
    return [
        'external_id'=>$externalId,'raw_label'=>$label,'source_page'=>$sourcePage,'group_number'=>$groupNumber,
        'round_label'=>$roundLabel,'round_number'=>$roundNumber,'stage_order'=>$stageOrder,'best_of_legs'=>$bestOf,'legs_to_win'=>$legsToWin,
        'player_a_external_id'=>$matched['a'],'player_b_external_id'=>$matched['b'],'winner_external_id'=>$winner,
        'score_a'=>$matched['score_a'],'score_b'=>$matched['score_b'],'average_a'=>$matched['avg_a'],'average_b'=>$matched['avg_b'],
    ];
};

$matches = [];
foreach ($groupConfigs as $cfg) {
    $groupNumber = (int) $cfg['number'];
    $pageName = (string) $cfg['page'];
    foreach ((array) ($source['pages'][$pageName]['matches'] ?? []) as $externalId => $label) {
        $externalId = (string) $externalId;
        if (!in_array($externalId, $manifestMatchIds, true)) throw new RuntimeException("Unexpected match {$externalId} on {$pageName}");
        $matches[$externalId] = $parseMatch($externalId, (string) $label, $groupNumber, $pageName);
    }
}
$resultsPage = $source['pages']['results'] ?? null;
if (!is_array($resultsPage) || (int) ($resultsPage['status'] ?? 0) !== 200) throw new RuntimeException('Missing Atlas results page.');
foreach ((array) ($resultsPage['matches'] ?? []) as $externalId => $label) {
    $externalId = (string) $externalId;
    if (!in_array($externalId, $manifestMatchIds, true)) throw new RuntimeException("Unexpected playoff match {$externalId}");
    $matches[$externalId] = $parseMatch($externalId, (string) $label, null, 'results');
}
if (count($matches) !== $expectedMatches) throw new RuntimeException("Expected {$expectedMatches} parsed matches, got " . count($matches));
$missingMatchIds = array_values(array_diff($manifestMatchIds, array_keys($matches)));
if ($missingMatchIds !== []) throw new RuntimeException('Frozen match IDs missing from source: ' . implode(',', $missingMatchIds));

$playoffMatches = array_values(array_filter($matches, static fn(array $m): bool => $m['group_number'] === null));
$finals = array_values(array_filter($playoffMatches, static fn(array $m): bool => $m['round_label'] === 'Final'));
if (count($finals) !== 1) throw new RuntimeException('Expected exactly one final.');
$final = $finals[0];
if ($final['winner_external_id'] !== $championExternalId) throw new RuntimeException('Manifest champion differs from final winner.');

$db = new mysqli($required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'), $required('DB_NAME'), (int) $required('DB_PORT'));
$db->set_charset('utf8mb4');
$externalSystem = 'dartsatlas';
$db->begin_transaction();
try {
    $clubRow = $db->query("SELECT id FROM `{$prefix}clubs` WHERE slug='blindleia-dartklubb' LIMIT 1")->fetch_assoc();
    if ($clubRow === null) throw new RuntimeException('Blindleia TEST club not found.');
    $clubId = (int) $clubRow['id'];

    $refFind = $db->prepare("SELECT internal_id FROM `{$prefix}external_references` WHERE external_system=? AND external_entity_type=? AND external_id=? LIMIT 1");
    $referenceUpsert = $db->prepare(
        "INSERT INTO `{$prefix}external_references` (external_system,external_entity_type,external_id,internal_entity_type,internal_id,sync_state,last_synced_at)
         VALUES (?,?,?,?,?,'synced',NOW()) ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),internal_id=VALUES(internal_id),sync_state='synced',last_synced_at=NOW()"
    );
    $putReference = static function (string $externalType, string $externalId, string $internalType, int $internalId) use ($referenceUpsert, $externalSystem): void {
        $referenceUpsert->bind_param('ssssi', $externalSystem, $externalType, $externalId, $internalType, $internalId); $referenceUpsert->execute();
    };

    $localPlayers = [];
    $allLocalRows = $db->query("SELECT id,display_name,member_id,is_active FROM `{$prefix}players` WHERE club_id={$clubId} OR club_id IS NULL ORDER BY id")->fetch_all(MYSQLI_ASSOC);
    $byName = [];
    foreach ($allLocalRows as $row) $byName[$normalise((string)$row['display_name'])][] = $row;
    foreach ($manifestPlayers as $externalId => $displayName) {
        $externalType='player'; $externalId=(string)$externalId;
        $refFind->bind_param('sss', $externalSystem, $externalType, $externalId); $refFind->execute(); $ref=$refFind->get_result()->fetch_assoc();
        $localId = $ref !== null ? (int)$ref['internal_id'] : 0;
        if ($localId > 0) {
            $exists = $db->query("SELECT id FROM `{$prefix}players` WHERE id={$localId} LIMIT 1")->fetch_assoc();
            if ($exists === null) $localId = 0;
        }
        if ($localId === 0) {
            $candidates = $byName[$normalise((string)$displayName)] ?? [];
            if ($candidates === []) {
                $insert=$db->prepare("INSERT INTO `{$prefix}players` (club_id,display_name,is_active,member_link_source) VALUES (?,?,1,'dartsatlas_import')");
                $insert->bind_param('is',$clubId,$displayName);$insert->execute();$localId=(int)$insert->insert_id;$insert->close();
            } else {
                usort($candidates, static function(array $a,array $b):int { $la=$a['member_id']!==null?1:0;$lb=$b['member_id']!==null?1:0;if($la!==$lb)return $lb<=>$la;$aa=(int)$a['is_active'];$ab=(int)$b['is_active'];if($aa!==$ab)return $ab<=>$aa;return (int)$a['id']<=>(int)$b['id']; });
                $localId=(int)$candidates[0]['id'];
            }
        }
        $localPlayers[$externalId]=$localId; $putReference('player',$externalId,'player',$localId);
    }

    $seasonId=0;$externalType='season';$refFind->bind_param('sss',$externalSystem,$externalType,$seasonExternalId);$refFind->execute();$row=$refFind->get_result()->fetch_assoc();if($row)$seasonId=(int)$row['internal_id'];
    if ($seasonId===0) { $stmt=$db->prepare("SELECT id FROM `{$prefix}seasons` WHERE club_id=? AND name=? LIMIT 1");$stmt->bind_param('is',$clubId,$seasonName);$stmt->execute();$r=$stmt->get_result()->fetch_assoc();$stmt->close();if($r)$seasonId=(int)$r['id']; }
    if ($seasonId===0) { $stmt=$db->prepare("INSERT INTO `{$prefix}seasons` (club_id,name,starts_on,ends_on,is_active,status,ranking_method) VALUES (?,?,?,?,1,'active','linear')");$stmt->bind_param('isss',$clubId,$seasonName,$seasonStartsOn,$seasonEndsOn);$stmt->execute();$seasonId=(int)$stmt->insert_id;$stmt->close(); }
    else { $stmt=$db->prepare("UPDATE `{$prefix}seasons` SET name=?,starts_on=?,ends_on=?,is_active=1,status='active',ranking_method='linear' WHERE id=?");$stmt->bind_param('sssi',$seasonName,$seasonStartsOn,$seasonEndsOn,$seasonId);$stmt->execute();$stmt->close(); }
    $putReference('season',$seasonExternalId,'season',$seasonId);

    $tournamentId=0;$existingFinal=false;$externalType='tournament';$refFind->bind_param('sss',$externalSystem,$externalType,$tournamentExternalId);$refFind->execute();$row=$refFind->get_result()->fetch_assoc();if($row)$tournamentId=(int)$row['internal_id'];
    if($tournamentId>0){$r=$db->query("SELECT status,end_at FROM `{$prefix}tournaments` WHERE id={$tournamentId} LIMIT 1")->fetch_assoc();$existingFinal=$r!==null && (string)$r['status']==='completed' && !empty($r['end_at']);}
    $metadata=json_encode(['source'=>'dartsatlas_history_import','external_id'=>$tournamentExternalId,'external_season_id'=>$seasonExternalId,'source_url'=>'https://www.dartsatlas.com/tournaments/'.$tournamentExternalId,'source_date'=>$tournamentDate,'manifest'=>'infra/atlas/manifests/'.basename($manifestPath),'completeness'=>['matches'=>'complete','match_averages'=>'complete','legs'=>'pending_detail_import','visits'=>'pending_detail_import']],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
    if($tournamentId===0){$stmt=$db->prepare("INSERT INTO `{$prefix}tournaments` (club_id,season_id,name,slug,provider_system,provider_metadata,status,start_at,end_at,elo_enabled) VALUES (?,?,?,?,'historical_import',?,'draft',?,NULL,1)");$stmt->bind_param('iissss',$clubId,$seasonId,$tournamentName,$slug,$metadata,$tournamentStartAt);$stmt->execute();$tournamentId=(int)$stmt->insert_id;$stmt->close();}
    elseif($existingFinal){$stmt=$db->prepare("UPDATE `{$prefix}tournaments` SET club_id=?,season_id=?,name=?,slug=?,provider_system='historical_import',provider_metadata=?,start_at=?,elo_enabled=1 WHERE id=?");$stmt->bind_param('iissssi',$clubId,$seasonId,$tournamentName,$slug,$metadata,$tournamentStartAt,$tournamentId);$stmt->execute();$stmt->close();}
    else{$stmt=$db->prepare("UPDATE `{$prefix}tournaments` SET club_id=?,season_id=?,name=?,slug=?,provider_system='historical_import',provider_metadata=?,status='draft',start_at=?,end_at=NULL,elo_enabled=1 WHERE id=?");$stmt->bind_param('iissssi',$clubId,$seasonId,$tournamentName,$slug,$metadata,$tournamentStartAt,$tournamentId);$stmt->execute();$stmt->close();}
    $putReference('tournament',$tournamentExternalId,'tournament',$tournamentId);

    $registration=$db->prepare("INSERT INTO `{$prefix}tournament_players` (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source) VALUES (?,?,'checked_in','legacy',?,'legacy') ON DUPLICATE KEY UPDATE registration_source='legacy',checkin_source='legacy'");
    foreach($localPlayers as $localId){$registration->bind_param('iis',$tournamentId,$localId,$tournamentStartAt);$registration->execute();}$registration->close();

    $groupIds=[];$groupPositions=[];
    foreach($groupConfigs as $cfg){$n=(int)$cfg['number'];$name='Group '.$n;$stmt=$db->prepare("SELECT id FROM `{$prefix}tournament_groups` WHERE tournament_id=? AND sort_order=? LIMIT 1");$stmt->bind_param('ii',$tournamentId,$n);$stmt->execute();$r=$stmt->get_result()->fetch_assoc();$stmt->close();
        if(!$r){$mode='historical_import';$seed=0;$stmt=$db->prepare("INSERT INTO `{$prefix}tournament_groups` (tournament_id,name,sort_order,draw_mode,draw_seed,generated_at) VALUES (?,?,?,?,?,?)");$stmt->bind_param('isisis',$tournamentId,$name,$n,$mode,$seed,$tournamentStartAt);$stmt->execute();$gid=(int)$stmt->insert_id;$stmt->close();}else{$gid=(int)$r['id'];$stmt=$db->prepare("UPDATE `{$prefix}tournament_groups` SET name=?,draw_mode='historical_import',draw_seed=0 WHERE id=?");$stmt->bind_param('si',$name,$gid);$stmt->execute();$stmt->close();}
        $groupIds[$n]=$gid;$db->query("DELETE FROM `{$prefix}tournament_group_players` WHERE group_id={$gid}");$ins=$db->prepare("INSERT INTO `{$prefix}tournament_group_players` (group_id,tournament_player_id,position,seed_number,seed_rating,seed_rating_source) SELECT ?,tp.id,?,NULL,NULL,'dartsatlas_import' FROM `{$prefix}tournament_players` tp WHERE tp.tournament_id=? AND tp.player_id=? LIMIT 1");
        foreach($groupExternalOrder[$n] as $idx=>$eid){$pos=$idx+1;$pid=$localPlayers[$eid];$ins->bind_param('iiii',$gid,$pos,$tournamentId,$pid);$ins->execute();if($ins->affected_rows!==1)throw new RuntimeException("Could not assign {$eid} to group {$n}");$groupPositions[$eid]=['group_id'=>$gid,'position'=>$pos];}$ins->close();
    }

    $matchesOrdered=array_values($matches);usort($matchesOrdered,static fn(array $a,array $b):int=>($a['stage_order']<=>$b['stage_order'])?:strcmp($a['external_id'],$b['external_id']));
    $matchLocalIds=[];$order=0;
    foreach($matchesOrdered as $m){$order++;$pa=$localPlayers[$m['player_a_external_id']];$pb=$localPlayers[$m['player_b_external_id']];$winner=$localPlayers[$m['winner_external_id']];$gid=$m['group_number']!==null?$groupIds[$m['group_number']]:null;$bracket=$m['group_number']!==null?'group':'single_elimination';$pm=json_encode(['source'=>'dartsatlas_history_import','external_id'=>$m['external_id'],'source_page'=>$m['source_page'],'source_label'=>$m['raw_label'],'source_scores'=>[$m['score_a'],$m['score_b']],'import_order'=>$order,'completeness'=>'aggregate_result_and_average','finished_at_precision'=>'historical_event_timestamp'],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        $mid=0;$externalType='match';$eid=$m['external_id'];$refFind->bind_param('sss',$externalSystem,$externalType,$eid);$refFind->execute();$r=$refFind->get_result()->fetch_assoc();if($r)$mid=(int)$r['internal_id'];$rl=$m['round_label'];$rn=$m['round_number'];$bo=$m['best_of_legs'];$ltw=$m['legs_to_win'];
        if($mid===0){$stmt=$db->prepare("INSERT INTO `{$prefix}matches` (tournament_id,tournament_group_id,round_label,round_number,bracket_label,provider_metadata,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,finished_at) VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?,?)");$stmt->bind_param('iisissiiiiis',$tournamentId,$gid,$rl,$rn,$bracket,$pm,$bo,$ltw,$pa,$pb,$winner,$tournamentStartAt);$stmt->execute();$mid=(int)$stmt->insert_id;$stmt->close();}
        else{$stmt=$db->prepare("UPDATE `{$prefix}matches` SET tournament_id=?,tournament_group_id=?,round_label=?,round_number=?,bracket_label=?,provider_metadata=?,status='completed',best_of_legs=?,legs_to_win=?,player_a_id=?,player_b_id=?,winner_player_id=?,finished_at=? WHERE id=?");$stmt->bind_param('iisissiiiiisi',$tournamentId,$gid,$rl,$rn,$bracket,$pm,$bo,$ltw,$pa,$pb,$winner,$tournamentStartAt,$mid);$stmt->execute();$stmt->close();}
        $putReference('match',$eid,'match',$mid);$matchLocalIds[$eid]=$mid;$stats=$db->prepare("INSERT INTO `{$prefix}match_statistics` (match_id,player_id,legs_won,average,provider_metadata) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE legs_won=VALUES(legs_won),average=VALUES(average),provider_metadata=VALUES(provider_metadata),updated_at=NOW()");$sm=json_encode(['source'=>'dartsatlas_history_import','external_match_id'=>$eid],JSON_UNESCAPED_SLASHES);$sa=$m['score_a'];$sb=$m['score_b'];$aa=$m['average_a'];$ab=$m['average_b'];$stats->bind_param('iiids',$mid,$pa,$sa,$aa,$sm);$stats->execute();$stats->bind_param('iiids',$mid,$pb,$sb,$ab,$sm);$stats->execute();$stats->close();
    }

    $playoffId=0;$stmt=$db->prepare("SELECT id FROM `{$prefix}tournament_playoffs` WHERE tournament_id=? LIMIT 1");$stmt->bind_param('i',$tournamentId);$stmt->execute();$r=$stmt->get_result()->fetch_assoc();$stmt->close();if($r)$playoffId=(int)$r['id'];
    $championId=$localPlayers[$championExternalId];$bracketSize=(int)($playoffConfig['bracket_size']??0);$qualifiers=(int)($playoffConfig['qualifiers_per_group']??0);$playoffBestOf=(int)($playoffConfig['best_of_legs']??3);
    if($playoffId===0){$stmt=$db->prepare("INSERT INTO `{$prefix}tournament_playoffs` (tournament_id,format,qualifiers_per_group,bracket_size,best_of_legs,status,champion_player_id) VALUES (?,'single_elimination',?,?,?,'completed',?)");$stmt->bind_param('iiiii',$tournamentId,$qualifiers,$bracketSize,$playoffBestOf,$championId);$stmt->execute();$playoffId=(int)$stmt->insert_id;$stmt->close();}
    else{$stmt=$db->prepare("UPDATE `{$prefix}tournament_playoffs` SET format='single_elimination',qualifiers_per_group=?,bracket_size=?,best_of_legs=?,status='completed',champion_player_id=? WHERE id=?");$stmt->bind_param('iiiii',$qualifiers,$bracketSize,$playoffBestOf,$championId,$playoffId);$stmt->execute();$stmt->close();$db->query("DELETE FROM `{$prefix}tournament_playoff_nodes` WHERE playoff_id={$playoffId}");$db->query("DELETE FROM `{$prefix}tournament_playoff_entries` WHERE playoff_id={$playoffId}");}

    $availableRounds=[];foreach(['Round of 16','Quarter-Final','Semi-Final','Final'] as $label){if(array_filter($playoffMatches,static fn(array $m):bool=>$m['round_label']===$label))$availableRounds[]=$label;}
    if($availableRounds===[] || end($availableRounds)!=='Final')throw new RuntimeException('Playoff rounds are incomplete.');$earliest=$availableRounds[0];$earliestMatches=array_values(array_filter($playoffMatches,static fn(array $m):bool=>$m['round_label']===$earliest));$qualifierExternal=[];foreach($earliestMatches as $m)foreach([$m['player_a_external_id'],$m['player_b_external_id']] as $eid)if(!in_array($eid,$qualifierExternal,true))$qualifierExternal[]=$eid;if(count($qualifierExternal)!==$bracketSize)throw new RuntimeException('Playoff qualifier count differs from bracket size.');
    $entry=$db->prepare("INSERT INTO `{$prefix}tournament_playoff_entries` (playoff_id,player_id,seed_number,source_group_id,source_group_position,source_points,source_leg_diff,source_legs_won) VALUES (?,?,?,?,?,0,0,0)");foreach($qualifierExternal as $idx=>$eid){$seed=$idx+1;$pid=$localPlayers[$eid];$gid=$groupPositions[$eid]['group_id'];$pos=$groupPositions[$eid]['position'];$entry->bind_param('iiiii',$playoffId,$pid,$seed,$gid,$pos);$entry->execute();}$entry->close();
    $node=$db->prepare("INSERT INTO `{$prefix}tournament_playoff_nodes` (playoff_id,round_number,position,round_label,player_a_id,player_b_id,match_id,winner_player_id,status) VALUES (?,?,?,?,?,?,?,?,'completed')");$positions=[];foreach($playoffMatches as $m){$nr=array_search($m['round_label'],$availableRounds,true);if($nr===false)continue;$roundNo=$nr+1;$positions[$roundNo]=($positions[$roundNo]??0)+1;$pos=$positions[$roundNo];$rl=$m['round_label'];$pa=$localPlayers[$m['player_a_external_id']];$pb=$localPlayers[$m['player_b_external_id']];$mid=$matchLocalIds[$m['external_id']];$winner=$localPlayers[$m['winner_external_id']];$node->bind_param('iiisiiii',$playoffId,$roundNo,$pos,$rl,$pa,$pb,$mid,$winner);$node->execute();}$node->close();
    $expectedNodes=(int)($playoffConfig['expected_nodes']??0);$nodeCount=(int)($db->query("SELECT COUNT(*) c FROM `{$prefix}tournament_playoff_nodes` WHERE playoff_id={$playoffId}")->fetch_assoc()['c']??0);if($expectedNodes>0&&$nodeCount!==$expectedNodes)throw new RuntimeException("Expected {$expectedNodes} playoff nodes, got {$nodeCount}");

    $points=array_fill_keys(array_keys($manifestPlayers),1.0);$stage=array_fill_keys(array_keys($manifestPlayers),'Group stage');$nonFinalRounds=array_values(array_filter($availableRounds,static fn(string $r):bool=>$r!=='Final'));
    foreach($nonFinalRounds as $idx=>$label){foreach(array_filter($playoffMatches,static fn(array $m):bool=>$m['round_label']===$label) as $m){$loser=$m['winner_external_id']===$m['player_a_external_id']?$m['player_b_external_id']:$m['player_a_external_id'];$points[$loser]=(float)($idx+2);$stage[$loser]=$label;}}
    $finalist=$final['winner_external_id']===$final['player_a_external_id']?$final['player_b_external_id']:$final['player_a_external_id'];$finalistPoints=(float)(count($nonFinalRounds)+2);$championPoints=$finalistPoints+1.0;$points[$finalist]=$finalistPoints;$stage[$finalist]='Final';$points[$championExternalId]=$championPoints;$stage[$championExternalId]='Champion';
    $ranking=$db->prepare("INSERT INTO `{$prefix}season_ranking_events` (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,source_reference,status,metadata_json,applied_at) VALUES (?,?,?,?,?,?,?,'linear_v1','dartsatlas_import',?,'applied',?,?) ON DUPLICATE KEY UPDATE season_id=VALUES(season_id),entrants=VALUES(entrants),stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),points=VALUES(points),source='dartsatlas_import',status='applied',metadata_json=VALUES(metadata_json),reverted_at=NULL,applied_at=VALUES(applied_at)");
    foreach($points as $eid=>$p){$pid=$localPlayers[$eid];$sl=$stage[$eid];$sn=(int)$p;$src=$tournamentExternalId.':'.$eid;$meta=json_encode(['source'=>'dartsatlas_history_import','external_player_id'=>$eid],JSON_UNESCAPED_SLASHES);$entrants=$expectedPlayers;$ranking->bind_param('iiiiidssss',$seasonId,$tournamentId,$pid,$entrants,$sl,$sn,$p,$src,$meta,$tournamentStartAt);$ranking->execute();}$ranking->close();

    $metadata=json_encode(['source'=>'dartsatlas_history_import','external_id'=>$tournamentExternalId,'external_season_id'=>$seasonExternalId,'source_url'=>'https://www.dartsatlas.com/tournaments/'.$tournamentExternalId,'source_date'=>$tournamentDate,'manifest'=>'infra/atlas/manifests/'.basename($manifestPath),'completeness'=>['matches'=>'complete','match_averages'=>'complete','legs'=>'pending_detail_import','visits'=>'pending_detail_import'],'source_counts'=>['players'=>$expectedPlayers,'matches'=>$expectedMatches,'playoff_nodes'=>$nodeCount]],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);$stmt=$db->prepare("UPDATE `{$prefix}tournaments` SET provider_metadata=? WHERE id=?");$stmt->bind_param('si',$metadata,$tournamentId);$stmt->execute();$stmt->close();
    $refFind->close();$referenceUpsert->close();$db->commit();

    $counts=[];foreach(['players'=>"SELECT COUNT(*) c FROM `{$prefix}tournament_players` WHERE tournament_id={$tournamentId}",'groups'=>"SELECT COUNT(*) c FROM `{$prefix}tournament_groups` WHERE tournament_id={$tournamentId}",'matches'=>"SELECT COUNT(*) c FROM `{$prefix}matches` WHERE tournament_id={$tournamentId}",'statistics'=>"SELECT COUNT(*) c FROM `{$prefix}match_statistics` ms JOIN `{$prefix}matches` m ON m.id=ms.match_id WHERE m.tournament_id={$tournamentId}",'ranking_events'=>"SELECT COUNT(*) c FROM `{$prefix}season_ranking_events` WHERE tournament_id={$tournamentId} AND status='applied'",'playoff_nodes'=>"SELECT COUNT(*) c FROM `{$prefix}tournament_playoff_nodes` n JOIN `{$prefix}tournament_playoffs` p ON p.id=n.playoff_id WHERE p.tournament_id={$tournamentId}"] as $key=>$sql)$counts[$key]=(int)($db->query($sql)->fetch_assoc()['c']??0);
    if($counts['players']!==$expectedPlayers||$counts['matches']!==$expectedMatches||$counts['statistics']!==$expectedMatches*2||$counts['ranking_events']!==$expectedPlayers||($expectedNodes>0&&$counts['playoff_nodes']!==$expectedNodes))throw new RuntimeException('Post-import structural inventory does not match manifest: '.json_encode($counts));
    echo 'ATLAS_TOURNAMENT_IMPORT_OK ' . json_encode(['external_id'=>$tournamentExternalId,'tournament_id'=>$tournamentId,'existing_final_preserved'=>$existingFinal,'counts'=>$counts,'champion_player_id'=>$championId],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES) . PHP_EOL;
} catch(Throwable $error){$db->rollback();throw $error;} finally {$db->close();}
