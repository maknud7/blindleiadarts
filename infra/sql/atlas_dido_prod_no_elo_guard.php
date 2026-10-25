<?php
declare(strict_types=1);
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
if (PHP_SAPI !== 'cli') throw new RuntimeException('CLI only');
$phase=$argv[1]??'';
if (!in_array($phase,['plan','verify'],true)) throw new RuntimeException('Usage: dido_prod_no_elo_guard.php plan|verify');
if (getenv('DB_TABLE_PREFIX')!=='bd_prod_' || getenv('DIDO_NO_ELO_GUARD')!=='yes') throw new RuntimeException('Production no-ELO guard requires explicit env');
$db=new mysqli((string)getenv('DB_HOST'),(string)getenv('DB_USERNAME'),(string)getenv('DB_PASSWORD'),(string)getenv('DB_NAME'),(int)getenv('DB_PORT'));
$db->set_charset('utf8mb4');
$reference=static function(string $prefix) use($db):?array {
  $id='UBKzQpfMMwyB';
  $s=$db->prepare("SELECT t.* FROM `{$prefix}external_references` er INNER JOIN `{$prefix}tournaments` t ON t.id=er.internal_id WHERE er.external_system='dartsatlas' AND er.external_entity_type='tournament' AND er.external_id=? LIMIT 1");
  $s->bind_param('s',$id);$s->execute();$r=$s->get_result()->fetch_assoc()?:null;$s->close();return $r;
};
$snapshot=static function()use($db):string {
  $all=[];
  foreach(['elo_current_ratings','elo_match_events','tournament_elo_snapshots'] as $suffix){
    $rows=$db->query("SELECT * FROM `bd_prod_{$suffix}`")->fetch_all(MYSQLI_ASSOC);
    usort($rows,static fn($a,$b):int=>strcmp(json_encode($a),json_encode($b)));
    $all[$suffix]=$rows;
  }
  return hash('sha256',json_encode($all,JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES));
};
$validate=static function(array $t,string $prefix)use($db):array {
  if($t['name']!=='Blindleia Grand Prix 2026'||$t['season_id']!==null||(int)$t['elo_enabled']!==0||$t['status']!=='completed'||empty($t['end_at']))throw new RuntimeException('Invalid standalone completed no-ELO tournament '.$prefix);
  $id=(int)$t['id'];
  foreach(['elo_match_events','tournament_elo_snapshots','season_ranking_events'] as $suffix){
    $n=(int)$db->query("SELECT COUNT(*) c FROM `{$prefix}{$suffix}` WHERE tournament_id={$id}")->fetch_assoc()['c'];
    if($n!==0)throw new RuntimeException("Illegal {$prefix}{$suffix}: {$n}");
  }
  $stats=[];
  $stats['players']=(int)$db->query("SELECT COUNT(*) c FROM `{$prefix}tournament_players` WHERE tournament_id={$id}")->fetch_assoc()['c'];
  $stats['matches']=(int)$db->query("SELECT COUNT(*) c FROM `{$prefix}matches` WHERE tournament_id={$id}")->fetch_assoc()['c'];
  $stats['legs']=(int)$db->query("SELECT COUNT(*) c FROM `{$prefix}legs` l JOIN `{$prefix}matches` m ON m.id=l.match_id WHERE m.tournament_id={$id}")->fetch_assoc()['c'];
  $stats['visits']=(int)$db->query("SELECT COUNT(*) c FROM `{$prefix}visits` v JOIN `{$prefix}matches` m ON m.id=v.match_id WHERE m.tournament_id={$id}")->fetch_assoc()['c'];
  if($stats['players']!==18||$stats['matches']!==79||$stats['legs']!==88||$stats['visits']<176)throw new RuntimeException('Incomplete tournament data: '.json_encode($stats));
  return $stats;
};
$baseline='/tmp/grandprix-dido-prod-elo-checksum.txt';
if($phase==='plan'){
  $test=$reference('bd_test_');
  if(!$test)throw new RuntimeException('Canonical TEST tournament not found');
  $counts=$validate($test,'bd_test_');
  if($reference('bd_prod_'))throw new RuntimeException('PROD tournament already exists');
  $testId=(int)$test['id'];
  $refs=(int)$db->query("SELECT COUNT(*) c FROM bd_test_external_references WHERE external_system='dartsatlas' AND external_entity_type='player' AND internal_id IN (SELECT player_id FROM bd_test_tournament_players WHERE tournament_id={$testId})")->fetch_assoc()['c'];
  if($refs<18)throw new RuntimeException('Missing player references');
  $manifest=['mode'=>'standalone_no_elo','source_prefix'=>'bd_test_','target_prefix'=>'bd_prod_','club_slug'=>'blindleia-dartklubb','season_external_id'=>'','elo_enabled'=>false,'ranking_points_enabled'=>false,'tournaments'=>[['external_id'=>'UBKzQpfMMwyB','name'=>'Blindleia Grand Prix 2026','expected_players'=>18,'expected_matches'=>79,'expected_legs'=>88,'expected_visits'=>$counts['visits']]],'expected_totals'=>['tournaments'=>1,'matches'=>79,'legs'=>88,'visits'=>$counts['visits'],'atlas_player_references'=>$refs]];
  file_put_contents('/tmp/grandprix-dido-promotion.json',json_encode($manifest,JSON_THROW_ON_ERROR|JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE));
  file_put_contents($baseline,$snapshot());
  echo 'DIDO_PROD_PLAN_NO_ELO_OK=yes '.json_encode($counts)." refs={$refs}\n";
}else{
  $prod=$reference('bd_prod_');
  if(!$prod)throw new RuntimeException('PROD tournament not found');
  $counts=$validate($prod,'bd_prod_');
  if(!is_file($baseline)||trim(file_get_contents($baseline))!==$snapshot())throw new RuntimeException('Global PROD ELO tables changed');
  echo 'DIDO_PROD_VERIFIED_NO_ELO_OK=yes id='.$prod['id'].' '.json_encode($counts).' backup_prefix='.getenv('PROD_BACKUP_PREFIX')."\n";
}
