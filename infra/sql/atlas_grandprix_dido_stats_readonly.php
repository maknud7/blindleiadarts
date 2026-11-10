<?php
declare(strict_types=1);
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
if (PHP_SAPI !== 'cli' || getenv('DB_TABLE_PREFIX') !== 'bd_test_') {
    throw new RuntimeException('Read-only Grand Prix statistics are TEST only');
}
$db=new mysqli((string)getenv('DB_HOST'),(string)getenv('DB_USERNAME'),(string)getenv('DB_PASSWORD'),(string)getenv('DB_NAME'),(int)getenv('DB_PORT'));
$db->set_charset('utf8mb4');
$r=$db->query("SELECT t.id,t.name,t.status,t.elo_enabled,t.season_id FROM bd_test_tournaments t JOIN bd_test_external_references e ON e.internal_id=t.id AND e.external_entity_type='tournament' AND e.internal_entity_type='tournament' WHERE e.external_system=CONCAT('darts','atlas') AND e.external_id='UBKzQpfMMwyB' LIMIT 1")->fetch_assoc();
if (!$r || $r['status']!=='completed' || (int)$r['elo_enabled']!==0 || $r['season_id']!==null) throw new RuntimeException('DiDo standalone source not confirmed');
$tid=(int)$r['id'];
$get=static function(string $sql) use($db,$tid):array {
  $s=$db->prepare($sql);
  $s->bind_param('i',$tid);
  $s->execute();
  $rows=$s->get_result()->fetch_all(MYSQLI_ASSOC);
  $s->close();
  return $rows;
};
$out=['tournament'=>$r];
$out['totals']=$get("SELECT (SELECT COUNT(*) FROM bd_test_tournament_players WHERE tournament_id=?) AS entrants");
$out['match_totals']=$get("SELECT COUNT(*) AS matches, SUM(bracket_label='group') AS group_matches, SUM(bracket_label='single_elimination') AS playoff_matches FROM bd_test_matches WHERE tournament_id=?");
$out['visits']=$get("SELECT COUNT(*) AS visits, SUM(v.darts_used) AS recorded_darts, SUM(v.score=180) AS one_eighties, SUM(v.score>=140 AND v.score<180) AS other_140_plus, SUM(v.score>=100 AND v.score<140) AS scores_100_139, MAX(v.score) AS max_score FROM bd_test_visits v JOIN bd_test_matches m ON m.id=v.match_id WHERE m.tournament_id=?");
$out['one_eighties']=$get("SELECT p.display_name,m.round_label,g.name AS group_name,v.score, e.external_id AS match_external_id FROM bd_test_visits v JOIN bd_test_matches m ON m.id=v.match_id JOIN bd_test_players p ON p.id=v.player_id LEFT JOIN bd_test_tournament_groups g ON g.id=m.tournament_group_id LEFT JOIN bd_test_external_references e ON e.internal_id=m.id AND e.external_entity_type='match' AND e.external_system=CONCAT('darts','atlas') WHERE m.tournament_id=? AND v.score=180 ORDER BY p.display_name,m.id");
$out['top_checkouts']=$get("SELECT p.display_name,v.score AS checkout,m.round_label,g.name AS group_name,v.darts_used,e.external_id AS match_external_id FROM bd_test_visits v JOIN bd_test_legs l ON l.id=v.leg_id JOIN bd_test_matches m ON m.id=v.match_id JOIN bd_test_players p ON p.id=v.player_id LEFT JOIN bd_test_tournament_groups g ON g.id=m.tournament_group_id LEFT JOIN bd_test_external_references e ON e.internal_id=m.id AND e.external_entity_type='match' AND e.external_system=CONCAT('darts','atlas') WHERE m.tournament_id=? AND v.player_id=l.winner_player_id AND v.remaining_after=0 AND v.is_bust=0 ORDER BY v.score DESC LIMIT 15");
$out['all_checkouts']=$get("SELECT COUNT(*) AS valid_checkouts,MAX(v.score) AS highest FROM bd_test_visits v JOIN bd_test_legs l ON l.id=v.leg_id JOIN bd_test_matches m ON m.id=v.match_id WHERE m.tournament_id=? AND v.player_id=l.winner_player_id AND v.remaining_after=0 AND v.is_bust=0");
$out['top_match_averages']=$get("SELECT p.display_name,ROUND(ms.average,2) AS average,m.round_label,g.name AS group_name,e.external_id AS match_external_id FROM bd_test_match_statistics ms JOIN bd_test_matches m ON m.id=ms.match_id JOIN bd_test_players p ON p.id=ms.player_id LEFT JOIN bd_test_tournament_groups g ON g.id=m.tournament_group_id LEFT JOIN bd_test_external_references e ON e.internal_id=m.id AND e.external_entity_type='match' AND e.external_system=CONCAT('darts','atlas') WHERE m.tournament_id=? AND ms.average IS NOT NULL ORDER BY ms.average DESC LIMIT 15");
$out['scoring_by_player']=$get("SELECT p.display_name,COUNT(*) AS visits,SUM(v.score=180) AS n180,SUM(v.score>=140 AND v.score<180) AS n140_179,SUM(v.score>=100 AND v.score<140) AS n100_139,MAX(v.score) AS best_visit FROM bd_test_visits v JOIN bd_test_matches m ON m.id=v.match_id JOIN bd_test_players p ON p.id=v.player_id WHERE m.tournament_id=? GROUP BY p.id,p.display_name ORDER BY n180 DESC,n140_179 DESC,n100_139 DESC,p.display_name");
$out['fastest_legs']=$get("SELECT p.display_name,m.round_label,g.name AS group_name,COUNT(v.id) AS visits,SUM(v.darts_used) AS winner_darts,l.leg_number,e.external_id AS match_external_id FROM bd_test_legs l JOIN bd_test_matches m ON m.id=l.match_id JOIN bd_test_players p ON p.id=l.winner_player_id JOIN bd_test_visits v ON v.leg_id=l.id AND v.player_id=l.winner_player_id LEFT JOIN bd_test_tournament_groups g ON g.id=m.tournament_group_id LEFT JOIN bd_test_external_references e ON e.internal_id=m.id AND e.external_entity_type='match' AND e.external_system=CONCAT('darts','atlas') WHERE m.tournament_id=? GROUP BY l.id,p.id,p.display_name,m.round_label,g.name,l.leg_number,e.external_id ORDER BY winner_darts ASC LIMIT 12");
$out['group_top']=$get("SELECT g.name,p.display_name,SUM(m.winner_player_id=p.id) AS wins,COUNT(m.id) AS played FROM bd_test_tournament_group_players gp JOIN bd_test_tournament_groups g ON g.id=gp.group_id JOIN bd_test_tournament_players tp ON tp.id=gp.tournament_player_id JOIN bd_test_players p ON p.id=tp.player_id JOIN bd_test_matches m ON m.tournament_group_id=g.id AND (m.player_a_id=p.id OR m.player_b_id=p.id) WHERE g.tournament_id=? GROUP BY g.id,p.id,p.display_name ORDER BY g.sort_order,wins DESC,p.display_name");
$out['playoffs']=$get("SELECT m.round_label,pa.display_name AS player_a,pb.display_name AS player_b,pw.display_name AS winner,msa.legs_won AS score_a,msb.legs_won AS score_b,msa.average AS avg_a,msb.average AS avg_b FROM bd_test_matches m JOIN bd_test_players pa ON pa.id=m.player_a_id JOIN bd_test_players pb ON pb.id=m.player_b_id JOIN bd_test_players pw ON pw.id=m.winner_player_id JOIN bd_test_match_statistics msa ON msa.match_id=m.id AND msa.player_id=m.player_a_id JOIN bd_test_match_statistics msb ON msb.match_id=m.id AND msb.player_id=m.player_b_id WHERE m.tournament_id=? AND m.bracket_label='single_elimination' ORDER BY FIELD(m.round_label,'Final','Semi-Final','Quarter-Final'),m.id");
echo "DIDO_STATS_JSON=".json_encode($out,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
