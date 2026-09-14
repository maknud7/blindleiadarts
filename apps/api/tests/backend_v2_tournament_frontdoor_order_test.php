<?php

declare(strict_types=1);

$indexPath = dirname(__DIR__) . '/index.php';
$source = file_get_contents($indexPath);
if ($source === false) {
    fwrite(STDERR, "Could not read apps/api/index.php\n");
    exit(1);
}

$tournamentNeedle = '$tournamentV2 = new BackendV2TournamentProxyApplication(__DIR__);';
$membershipNeedle = '$membershipEligibility = new MembershipEligibilityApplication(__DIR__);';

$tournamentPosition = strpos($source, $tournamentNeedle);
$membershipPosition = strpos($source, $membershipNeedle);

if ($tournamentPosition === false || $membershipPosition === false) {
    fwrite(STDERR, "Expected tournament and membership front doors were not both found in apps/api/index.php\n");
    exit(1);
}

if ($tournamentPosition >= $membershipPosition) {
    fwrite(STDERR, "BackendV2TournamentProxyApplication must run before MembershipEligibilityApplication so TEST self-registration reaches Node.\n");
    exit(1);
}

$proxyPath = dirname(__DIR__) . '/src/BackendV2TournamentProxyApplication.php';
$proxySource = file_get_contents($proxyPath);
if ($proxySource === false || strpos($proxySource, "['POST', 'DELETE']") === false || strpos($proxySource, '/register') === false) {
    fwrite(STDERR, "Tournament proxy must continue to own POST/DELETE self-registration before the order guarantee is meaningful.\n");
    exit(1);
}

echo "BackendV2 tournament self-registration frontdoor order OK\n";
