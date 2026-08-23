<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasParser;

require dirname(__DIR__, 3) . '/apps/api/bootstrap.php';

$parser = new DartsAtlasParser();

$season = $parser->parseSeason(
    '<html><head><title>Mandagsserien Høst 2026</title></head><body>'
    . '<a href="/seasons/rFByCgOqI1rq/player_stats/player-1">Magnus Knudsen</a>'
    . '<a href="/tournaments/tournament-1">Mandag 24. august</a>'
    . '</body></html>',
    'https://www.dartsatlas.com/seasons/rFByCgOqI1rq'
);

assert($season['external_id'] === 'rFByCgOqI1rq');
assert($season['players'][0]['external_id'] === 'player-1');
assert($season['tournaments'][0]['external_id'] === 'tournament-1');

$tournamentHtml = <<<'HTML'
<html><head><title>Mandagsserien 24.08</title></head><body>
<table><tr class="match-row">
<td><a href="/players/player-1">Magnus Knudsen</a></td>
<td>1 - 2</td>
<td><a href="/players/player-2">Thomas Kildal</a></td>
<td>Board 2 · Round 3 · Best of 3 · 58.42 Avg · 55,10 Avg</td>
<td><a href="/matches/match-1">Match</a></td>
</tr></table>
</body></html>
HTML;
$tournament = $parser->parseTournament($tournamentHtml, 'https://www.dartsatlas.com/tournaments/tournament-1');
$match = null;
foreach ($tournament['matches'] as $candidate) {
    if (($candidate['external_id'] ?? '') === 'match-1') {
        $match = $candidate;
        break;
    }
}
assert(is_array($match));
assert($match['player_a']['external_id'] === 'player-1');
assert($match['player_b']['external_id'] === 'player-2');
assert($match['player_a_legs'] === 1);
assert($match['player_b_legs'] === 2);
assert($match['board_number'] === 2);
assert($match['best_of_legs'] === 3);
assert($match['average_a'] === 58.42);
assert($match['average_b'] === 55.10);
assert($match['status'] === 'completed');

$broadcast = $parser->parseBroadcast(
    '<div data-player-id="player-1" data-player-name="Magnus Knudsen" data-score="141" data-legs="2" data-average="58.42" data-score-180="1" data-highest-checkout="116"></div>'
    . '<div data-player-id="player-2" data-player-name="Thomas Kildal" data-score="204" data-legs="1" data-average="55,10"></div>',
    'match-1'
);
assert($broadcast['external_id'] === 'match-1');
assert($broadcast['players'][0]['score'] === 141);
assert($broadcast['players'][0]['legs'] === 2);
assert($broadcast['players'][0]['average'] === 58.42);
assert($broadcast['players'][0]['score_180'] === 1);
assert($broadcast['players'][0]['highest_checkout'] === 116);

fwrite(STDOUT, "DartsAtlas parser smoke test passed.\n");
