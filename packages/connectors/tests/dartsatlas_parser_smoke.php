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

$groupHtml = <<<'HTML'
<html><head><title>Group 1</title></head><body>
<nav>
<a href="/tournaments/PvGa73emrY6e/player_stats/player-a">Andre Kendrick</a>
<a href="/tournaments/PvGa73emrY6e/player_stats/player-b">Boye Buckingham</a>
<a href="/tournaments/PvGa73emrY6e/player_stats/player-c">Steffen Madsen</a>
<a href="/tournaments/PvGa73emrY6e/player_stats/player-d">Tormod Haga</a>
</nav>
<a href="/matches/group-match-1">Round 1 Best of 1 Andre Kendrick 1 Boye Buckingham 0 46.20 Avg 33.10 Avg</a>
<a href="/matches/group-match-live">Board 3 Round 8 Best of 1 Steffen Madsen 0 Tormod Haga 0 501 501</a>
</body></html>
HTML;
$group = $parser->parseTournament($groupHtml, 'https://www.dartsatlas.com/tournaments/PvGa73emrY6e');
$groupMatch = null;
$liveGroupMatch = null;
foreach ($group['matches'] as $candidate) {
    if (($candidate['external_id'] ?? '') === 'group-match-1') {
        $groupMatch = $candidate;
    }
    if (($candidate['external_id'] ?? '') === 'group-match-live') {
        $liveGroupMatch = $candidate;
    }
}
assert(is_array($groupMatch));
assert($groupMatch['player_a']['external_id'] === 'player-a');
assert($groupMatch['player_a']['name'] === 'Andre Kendrick');
assert($groupMatch['player_b']['external_id'] === 'player-b');
assert($groupMatch['player_b']['name'] === 'Boye Buckingham');
assert($groupMatch['player_a_legs'] === 1);
assert($groupMatch['player_b_legs'] === 0);
assert($groupMatch['best_of_legs'] === 1);
assert($groupMatch['average_a'] === 46.20);
assert($groupMatch['average_b'] === 33.10);
assert($groupMatch['status'] === 'completed');

assert(is_array($liveGroupMatch));
assert($liveGroupMatch['player_a']['external_id'] === 'player-c');
assert($liveGroupMatch['player_b']['external_id'] === 'player-d');
assert($liveGroupMatch['player_a_legs'] === 0);
assert($liveGroupMatch['player_b_legs'] === 0);
assert($liveGroupMatch['board_number'] === 3);
assert($liveGroupMatch['status'] === 'in_progress');

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
