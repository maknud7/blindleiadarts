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

$broadcastHtml = <<<'HTML'
<div data-player-id="player-1" data-player-name="Magnus Knudsen" data-score="141" data-legs="2" data-average="58.42" data-score-180="1"></div>
<div data-player-id="player-2" data-player-name="Test Player" data-score="204" data-legs="1" data-average="55,10"></div>
HTML;
$broadcast = $parser->parseBroadcast($broadcastHtml, 'match-1');
assert($broadcast['external_id'] === 'match-1');
assert($broadcast['players'][0]['score'] === 141);
assert($broadcast['players'][0]['legs'] === 2);
assert($broadcast['players'][0]['average'] === 58.42);
assert($broadcast['players'][0]['score_180'] === 1);
assert($broadcast['players'][1]['average'] === 55.10);

fwrite(STDOUT, "DartsAtlas parser smoke test passed.\n");
