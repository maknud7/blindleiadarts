<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/DartsAtlasHtmlParser.php';

$parser = new DartsAtlasHtmlParser();

$seasonHtml = <<<'HTML'
<html><head><title>Mandagsserien Høst 2026</title></head><body>
<a href="/seasons/rFByCgOqI1rq/player_stats/player-1">Magnus Knudsen</a>
<a href="/tournaments/tournament-1">Mandag 24. august</a>
</body></html>
HTML;
$season = $parser->parseSeason($seasonHtml, 'https://www.dartsatlas.com/seasons/rFByCgOqI1rq');
assert($season['external_id'] === 'rFByCgOqI1rq');
assert($season['players'][0]['external_id'] === 'player-1');
assert($season['players'][0]['name'] === 'Magnus Knudsen');
assert($season['tournaments'][0]['external_id'] === 'tournament-1');

$tournamentHtml = <<<'HTML'
<html><head><title>Mandag 24. august</title></head><body>
<a href="/tournaments/tournament-1/player_stats/player-1">Magnus Knudsen</a>
<a href="/tournaments/tournament-1/player_stats/player-2">Thomas Kildal</a>
<div class="match-row">
  <span>Board 2 Round 1 Best of 3</span>
  <a href="/tournaments/tournament-1/player_stats/player-1">Magnus Knudsen</a> 1
  <a href="/tournaments/tournament-1/player_stats/player-2">Thomas Kildal</a> 1
  <span>58.42 Avg 55.10 Avg</span>
  <a href="/matches/match-1">Match</a>
</div>
</body></html>
HTML;
$tournament = $parser->parseTournament($tournamentHtml, 'https://www.dartsatlas.com/tournaments/tournament-1');
assert(count($tournament['players']) === 2);
assert(count($tournament['matches']) === 1);
assert($tournament['matches'][0]['external_id'] === 'match-1');
assert($tournament['matches'][0]['board_number'] === 2);
assert($tournament['matches'][0]['round_label'] === 'Round 1');
assert($tournament['matches'][0]['status'] === 'in_progress');
assert($tournament['matches'][0]['player_a_legs'] === 1);
assert($tournament['matches'][0]['player_b_legs'] === 1);
assert($tournament['matches'][0]['average_a'] === 58.42);
assert($tournament['matches'][0]['average_b'] === 55.10);

$broadcastHtml = <<<'HTML'
<div data-player-id="player-1" data-player-name="Magnus Knudsen" data-score="141" data-legs="2" data-average="58.42" data-score-180="1"></div>
<div data-player-id="player-2" data-player-name="Thomas Kildal" data-score="204" data-legs="1" data-average="55,10"></div>
HTML;
$broadcast = $parser->parseBroadcast($broadcastHtml, 'match-1');
assert($broadcast['external_id'] === 'match-1');
assert($broadcast['players'][0]['score'] === 141);
assert($broadcast['players'][0]['legs'] === 2);
assert($broadcast['players'][0]['average'] === 58.42);
assert($broadcast['players'][0]['score_180'] === 1);
assert($broadcast['players'][1]['average'] === 55.10);

fwrite(STDOUT, "DartsAtlas parser smoke test passed.\n");
