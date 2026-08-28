<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};
$prefix = $required('DB_TABLE_PREFIX');
if ($prefix !== 'bd_test_') throw new RuntimeException("Refusing Atlas visit import outside bd_test_: {$prefix}");

$manifestPath = $argv[1] ?? '';
$payloadPath = $argv[2] ?? '';
if ($manifestPath === '' || !is_file($manifestPath) || $payloadPath === '' || !is_file($payloadPath)) {
    throw new RuntimeException('Usage: php import_atlas_manifest_visits_test.php <manifest.json> <match-json>');
}
$manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
$payload = json_decode((string) file_get_contents($payloadPath), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($manifest) || !is_array($payload) || ($payload['ok'] ?? false) !== true) throw new RuntimeException('Invalid manifest/match payload.');
$tournamentExternalId = (string) ($manifest['tournament_external_id'] ?? '');
$externalId = (string) ($payload['external_id'] ?? '');
if ($tournamentExternalId === '' || $externalId === '') throw new RuntimeException('Missing external IDs.');
$allowed = [];
foreach ((array) ($manifest['groups'] ?? []) as $group) foreach ((array) ($group['match_ids'] ?? []) as $id) $allowed[(string) $id] = true;
foreach ((array) ($manifest['playoff']['match_ids'] ?? []) as $id) $allowed[(string) $id] = true;
if (!isset($allowed[$externalId])) throw new RuntimeException("Match {$externalId} is not in frozen manifest.");
if (!is_array($payload['legs'] ?? null) || $payload['legs'] === []) throw new RuntimeException("No legs in payload for {$externalId}");

$db = new mysqli($required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'), $required('DB_NAME'), (int) $required('DB_PORT'));
$db->set_charset('utf8mb4');
$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
};

$stmt = $db->prepare("SELECT internal_id FROM `{$prefix}external_references` WHERE external_system='dartsatlas' AND external_entity_type='tournament' AND external_id=? AND internal_entity_type='tournament' LIMIT 1");
$stmt->bind_param('s', $tournamentExternalId); $stmt->execute(); $r = $stmt->get_result()->fetch_assoc(); $stmt->close();
if (!$r) throw new RuntimeException("Tournament {$tournamentExternalId} is not present in TEST.");
$tournamentId = (int) $r['internal_id'];

$find = $db->prepare("SELECT m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.best_of_legs,pa.display_name player_a_name,pb.display_name player_b_name FROM `{$prefix}external_references` er JOIN `{$prefix}matches` m ON m.id=er.internal_id AND er.internal_entity_type='match' JOIN `{$prefix}players` pa ON pa.id=m.player_a_id JOIN `{$prefix}players` pb ON pb.id=m.player_b_id WHERE er.external_system='dartsatlas' AND er.external_entity_type='match' AND er.external_id=? AND m.tournament_id=? LIMIT 1");
$find->bind_param('si', $externalId, $tournamentId); $find->execute(); $local = $find->get_result()->fetch_assoc() ?: null; $find->close();
if ($local === null) throw new RuntimeException("Local match not found for {$externalId}");
$matchId=(int)$local['id'];$playerAId=(int)$local['player_a_id'];$playerBId=(int)$local['player_b_id'];
$sourceA=(string)($payload['players']['a']??'');$sourceB=(string)($payload['players']['b']??'');$localA=(string)$local['player_a_name'];$localB=(string)$local['player_b_name'];
if($normalise($sourceA)===$normalise($localA)&&$normalise($sourceB)===$normalise($localB))$side=['a'=>$playerAId,'b'=>$playerBId];
elseif($normalise($sourceA)===$normalise($localB)&&$normalise($sourceB)===$normalise($localA))$side=['a'=>$playerBId,'b'=>$playerAId];
else throw new RuntimeException("Player mismatch for {$externalId}: {$sourceA}/{$sourceB} vs {$localA}/{$localB}");

$wins=['a'=>0,'b'=>0];foreach($payload['legs'] as $leg){$w=(string)($leg['winner_side']??'');if(!isset($side[$w]))throw new RuntimeException("Invalid winner side for {$externalId}");$wins[$w]++;}
if($wins['a']===$wins['b'])throw new RuntimeException("Parsed legs tied for {$externalId}");$winnerSide=$wins['a']>$wins['b']?'a':'b';
if($side[$winnerSide] !== (int)$local['winner_player_id'])throw new RuntimeException("Leg winner differs from stored result for {$externalId}");
if(count($payload['legs'])>(int)$local['best_of_legs'])throw new RuntimeException("Too many legs for {$externalId}");

$deleteVisits=$db->prepare("DELETE v FROM `{$prefix}visits` v INNER JOIN `{$prefix}legs` l ON l.id=v.leg_id WHERE l.match_id=?");
$deleteLegs=$db->prepare("DELETE FROM `{$prefix}legs` WHERE match_id=?");
$legInsert=$db->prepare("INSERT INTO `{$prefix}legs` (match_id,leg_number,starting_player_id,winner_player_id,status,start_score,finished_at) VALUES (?,?,NULL,?,'completed',501,NULL)");
$visitInsert=$db->prepare("INSERT INTO `{$prefix}visits` (match_id,leg_id,player_id,visit_number,score,darts_used,input_mode,darts_json,is_bust,remaining_after) VALUES (?,?,?,?,?,?,'sum',NULL,0,?)");
$statsUpdate=$db->prepare("UPDATE `{$prefix}match_statistics` SET darts_thrown=?,checkout_hits=?,highest_checkout=?,score_100_plus=?,score_140_plus=?,score_180=?,provider_metadata=JSON_SET(COALESCE(provider_metadata,JSON_OBJECT()),'$.visits_source','dartsatlas_match_page') WHERE match_id=? AND player_id=?");
$countLegs=$db->prepare("SELECT COUNT(*) c FROM `{$prefix}legs` WHERE match_id=?");$countVisits=$db->prepare("SELECT COUNT(*) c FROM `{$prefix}visits` WHERE match_id=?");

$db->begin_transaction();
try{
    $deleteVisits->bind_param('i',$matchId);$deleteVisits->execute();$deleteLegs->bind_param('i',$matchId);$deleteLegs->execute();
    $stats=[
        $playerAId=>['darts'=>0,'checkouts'=>0,'highest'=>0,'100'=>0,'140'=>0,'180'=>0],
        $playerBId=>['darts'=>0,'checkouts'=>0,'highest'=>0,'100'=>0,'140'=>0,'180'=>0],
    ];
    $matchLegs=0;$matchVisits=0;$matchDarts=0;$zeroVisits=0;
    foreach($payload['legs'] as $leg){
        $legNo=(int)($leg['leg_number']??0);$legWinner=(string)($leg['winner_side']??'');if($legNo<1||!isset($side[$legWinner]))throw new RuntimeException("Invalid leg in {$externalId}");$winnerPid=$side[$legWinner];
        $legInsert->bind_param('iii',$matchId,$legNo,$winnerPid);$legInsert->execute();$legId=(int)$legInsert->insert_id;$matchLegs++;
        foreach(['a'=>'player_a_visits','b'=>'player_b_visits'] as $s=>$key){
            $pid=$side[$s];$visits=is_array($leg[$key]??null)?$leg[$key]:[];if($visits===[])throw new RuntimeException("Missing visits {$externalId} leg {$legNo} {$s}");
            foreach($visits as $visit){$vn=(int)($visit['visit_number']??0);$score=(int)($visit['score']??-1);$darts=(int)($visit['darts_used']??0);$remaining=(int)($visit['remaining_after']??-1);if($vn<1||$score<0||$score>180||$darts<1||$darts>3||$remaining<0||$remaining>501)throw new RuntimeException("Invalid visit {$externalId} leg {$legNo}");$visitInsert->bind_param('iiiiiii',$matchId,$legId,$pid,$vn,$score,$darts,$remaining);$visitInsert->execute();$matchVisits++;$matchDarts+=$darts;if($score===0)$zeroVisits++;$stats[$pid]['darts']+=$darts;if($score===180)$stats[$pid]['180']++;elseif($score>=140)$stats[$pid]['140']++;elseif($score>=100)$stats[$pid]['100']++;}
            if($legWinner===$s){$last=$visits[array_key_last($visits)];$checkout=(int)($last['score']??0);$stats[$pid]['checkouts']++;$stats[$pid]['highest']=max($stats[$pid]['highest'],$checkout);}
        }
    }
    foreach($stats as $pid=>$x){$d=(int)$x['darts'];$co=(int)$x['checkouts'];$hi=(int)$x['highest'];$s100=(int)$x['100'];$s140=(int)$x['140'];$s180=(int)$x['180'];$statsUpdate->bind_param('iiiiiiii',$d,$co,$hi,$s100,$s140,$s180,$matchId,$pid);$statsUpdate->execute();if($statsUpdate->affected_rows<0)throw new RuntimeException("Statistics update failed {$externalId} player {$pid}");}
    $countLegs->bind_param('i',$matchId);$countLegs->execute();$storedLegs=(int)($countLegs->get_result()->fetch_assoc()['c']??0);$countVisits->bind_param('i',$matchId);$countVisits->execute();$storedVisits=(int)($countVisits->get_result()->fetch_assoc()['c']??0);$expectedLegs=(int)($payload['leg_count']??count($payload['legs']));$expectedVisits=(int)($payload['visit_count']??$matchVisits);
    if($storedLegs!==$matchLegs||$storedVisits!==$matchVisits||$matchLegs!==$expectedLegs||$matchVisits!==$expectedVisits)throw new RuntimeException('Atomic match validation failed '.json_encode(['external_id'=>$externalId,'stored_legs'=>$storedLegs,'parsed_legs'=>$matchLegs,'expected_legs'=>$expectedLegs,'stored_visits'=>$storedVisits,'parsed_visits'=>$matchVisits,'expected_visits'=>$expectedVisits]));
    $db->commit();
    echo "ATLAS_MATCH_VISITS_OK external_id={$externalId} match_id={$matchId} legs={$matchLegs} visits={$matchVisits} darts={$matchDarts} zero_visits={$zeroVisits}\n";
}catch(Throwable $e){$db->rollback();throw $e;}finally{
    $deleteVisits->close();$deleteLegs->close();$legInsert->close();$visitInsert->close();$statsUpdate->close();$countLegs->close();$countVisits->close();$db->close();
}
