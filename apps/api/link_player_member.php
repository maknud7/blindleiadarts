<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    fwrite(STDERR, "CLI only.\n");
    exit(1);
}

/** @var array{config:array<string,mixed>,db:mysqli,prefix:string,adapter:DartsAtlasLiveAdapter} $app */
$app = require __DIR__ . '/bootstrap.php';
$options = getopt('', ['player:', 'member:']);

$playerId = (int) ($options['player'] ?? 0);
$memberId = (int) ($options['member'] ?? 0);

if ($playerId <= 0 || $memberId <= 0) {
    fwrite(STDERR, "Usage: php apps/api/link_player_member.php --player=PLAYER_ID --member=MEMBER_ID\n");
    exit(1);
}

try {
    $app['adapter']->linkPlayerToMember($playerId, $memberId);
    fwrite(STDOUT, "Linked player {$playerId} to member {$memberId}.\n");
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}
