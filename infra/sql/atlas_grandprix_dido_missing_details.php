<?php
declare(strict_types=1);
mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);
if(PHP_SAPI!=='cli'||getenv('DB_TABLE_PREFIX')!=='bd_test_')throw new RuntimeException('Standalone DiDo TEST only');
$m=json_decode(file_get_contents(__DIR__.'/../atlas/manifests/grandprix-dido-2026-10-24.json'),true,512,JSON_THROW_ON_ERROR);
$ids=[];foreach($m['groups'] as $g)foreach($g['match_ids'] as $id)$ids[]=$id;foreach($m['playoff']['match_ids'] as $id)$ids[]=$id;
if(count($ids)!==79||count(array_unique($ids))!==79)throw new RuntimeException('Manifest mismatch');
$db=new mysqli((string)getenv('DB_HOST'),(string)getenv('DB_USERNAME'),(string)getenv('DB_PASSWORD'),(string)getenv('DB_NAME'),(int)getenv('DB_PORT'));
$db->set_charset('utf8mb4');
$ref=$db->prepare("SELECT m.id,m.tournament_id,COUNT(l.id) AS leg_count FROM bd_test_external_references e INNER JOIN bd_test_matches m ON m.id=e.internal_id LEFT JOIN bd_test_legs l ON l.match_id=m.id WHERE e.external_system=CONCAT('darts','atlas') AND e.external_entity_type='match' AND e.external_id=? GROUP BY m.id,m.tournament_id");
$missing=[];$seen=[];
foreach($ids as $id){
  $ref->bind_param('s',$id);$ref->execute();
  $r=$ref->get_result()->fetch_assoc();
  if(!$r)throw new RuntimeException('Missing match skeleton: '.$id);
  $seen[$r['tournament_id']]=true;
  if((int)$r['leg_count']===0)$missing[]=$id;
}
if(count($seen)!==1)throw new RuntimeException('Match source spans multiple tournaments');
echo implode("\n",$missing).($missing?"\n":"");
