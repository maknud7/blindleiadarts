<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\AccountProfileApplication;
use Blindleia\Dartkiosk\Api\ActivityApplication;
use Blindleia\Dartkiosk\Api\Application;
use Blindleia\Dartkiosk\Api\BackendV2EquipmentProxyApplication;
use Blindleia\Dartkiosk\Api\BackendV2PlayerLiveProxyApplication;
use Blindleia\Dartkiosk\Api\BackendV2ScoliaProxyApplication;
use Blindleia\Dartkiosk\Api\BackendV2TournamentProxyApplication;
use Blindleia\Dartkiosk\Api\EloApplication;
use Blindleia\Dartkiosk\Api\EmailAuthApplication;
use Blindleia\Dartkiosk\Api\EquipmentApplication;
use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\LiveHighlightsApplication;
use Blindleia\Dartkiosk\Api\MatchScoringApplication;
use Blindleia\Dartkiosk\Api\MembershipEligibilityApplication;
use Blindleia\Dartkiosk\Api\PasswordResetApplication;
use Blindleia\Dartkiosk\Api\PaymentSettingsApplication;
use Blindleia\Dartkiosk\Api\PlayerBreakApplication;
use Blindleia\Dartkiosk\Api\PlayerIdentityApplication;
use Blindleia\Dartkiosk\Api\PlayerPortalApplication;
use Blindleia\Dartkiosk\Api\ScoliaApplication;
use Blindleia\Dartkiosk\Api\SeasonApplication;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\TournamentAttendanceApplication;
use Blindleia\Dartkiosk\Api\TournamentCheckinApplication;
use Blindleia\Dartkiosk\Api\TournamentFeatureApplication;
use Blindleia\Dartkiosk\Api\TournamentFlowApplication;
use Blindleia\Dartkiosk\Api\TournamentOperationsApplication;
use Blindleia\Dartkiosk\Api\TournamentPlayoffApplication;
use Blindleia\Dartkiosk\Api\TournamentWizardApplication;

require __DIR__ . '/bootstrap.php';

// A production-installed board terminal may opt into the isolated test runtime.
// Only the canonical production kiosk origin is allowed to call the test API cross-origin.
$origin = trim((string) ($_SERVER['HTTP_ORIGIN'] ?? ''));
if ($origin === 'https://dart.ingenting.org') {
    header('Access-Control-Allow-Origin: https://dart.ingenting.org');
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Kiosk-Pairing-Token, X-Scolia-Bridge-Secret');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        return;
    }
}

// Physical club equipment has one canonical PROD master registry. TEST may read
// that registry and create/use local runtime aliases for pairing and matches, but
// it must never mutate board identity, activation, scoring type or Scolia master
// settings. Runtime-only actions such as pairing/reset-pairing remain available.
$config = Config::load(__DIR__);
if ($config->appEnv() === 'test') {
    $guardRequest = Request::fromGlobals();
    $guardMethod = $guardRequest->method();
    $guardPath = trim($guardRequest->path(), '/');

    $isBoardCreate = $guardMethod === 'POST'
        && preg_match('#^v1/clubs/\d+/kiosks$#', $guardPath) === 1;
    $isBoardMasterMutation = in_array($guardMethod, ['PUT', 'PATCH', 'DELETE'], true)
        && preg_match('#^v1/clubs/\d+/kiosks/\d+$#', $guardPath) === 1;
    $isBoardScoliaMasterMutation = in_array($guardMethod, ['PUT', 'PATCH'], true)
        && preg_match('#^v1/clubs/\d+/kiosks/\d+/scolia$#', $guardPath) === 1;
    $isClubScoliaMasterMutation = in_array($guardMethod, ['PUT', 'PATCH'], true)
        && preg_match('#^v1/clubs/\d+/scolia/settings$#', $guardPath) === 1;

    if ($isBoardCreate || $isBoardMasterMutation || $isBoardScoliaMasterMutation || $isClubScoliaMasterMutation) {
        header('X-BD-Hardware-Read-Only: 1');
        JsonResponse::error(
            403,
            'production_hardware_read_only',
            'Fysisk utstyr kan bare endres i PROD. TEST er skrivebeskyttet for skive- og Scolia-masterdata.'
        )->send();
        return;
    }
}

$activity = new ActivityApplication(__DIR__);
if ($activity->run()) {
    return;
}

$passwordReset = new PasswordResetApplication(__DIR__);
if ($passwordReset->run()) {
    return;
}

$emailAuth = new EmailAuthApplication(__DIR__);
if ($emailAuth->run()) {
    return;
}

$accountProfile = new AccountProfileApplication(__DIR__);
if ($accountProfile->run()) {
    return;
}

$membershipEligibility = new MembershipEligibilityApplication(__DIR__);
if ($membershipEligibility->run()) {
    return;
}

$paymentSettings = new PaymentSettingsApplication(__DIR__);
if ($paymentSettings->run()) {
    return;
}

// Player/public/live reads keep the Domeneshop same-origin API contract while
// the implementation is migrated to backend-v2. The proxy is GET-only and
// fail-closed after a Node attempt.
$playerLiveV2 = new BackendV2PlayerLiveProxyApplication(__DIR__);
if ($playerLiveV2->run()) {
    return;
}

// Equipment cutover keeps the public API on the Domeneshop same-origin front
// door. The proxy decides PHP vs Node before dispatch; after a Node attempt it
// fails closed and never invokes the legacy PHP writer.
$equipmentV2 = new BackendV2EquipmentProxyApplication(__DIR__);
if ($equipmentV2->run()) {
    return;
}

// Scolia bridge and paired-kiosk runtime have an independent single-writer
// routing gate. TEST can move to Node without changing PROD ownership.
$scoliaV2 = new BackendV2ScoliaProxyApplication(__DIR__);
if ($scoliaV2->run()) {
    return;
}

// Migrated tournament runtime has its own single-writer gate. Only routes that
// backend-v2 already owns are captured; all remaining tournament functionality
// continues to the legacy PHP applications below.
$tournamentV2 = new BackendV2TournamentProxyApplication(__DIR__);
if ($tournamentV2->run()) {
    return;
}

$equipment = new EquipmentApplication(__DIR__);
if ($equipment->run()) {
    return;
}

$scolia = new ScoliaApplication(__DIR__);
if ($scolia->run()) {
    return;
}

$attendance = new TournamentAttendanceApplication(__DIR__);
if ($attendance->run()) {
    return;
}

$checkin = new TournamentCheckinApplication(__DIR__);
if ($checkin->run()) {
    return;
}

$wizard = new TournamentWizardApplication(__DIR__);
if ($wizard->run()) {
    return;
}

$tournamentFlow = new TournamentFlowApplication(__DIR__);
if ($tournamentFlow->run()) {
    return;
}

$tournamentFeatures = new TournamentFeatureApplication(__DIR__);
if ($tournamentFeatures->run()) {
    return;
}

$playoffs = new TournamentPlayoffApplication(__DIR__);
if ($playoffs->run()) {
    return;
}

$playerBreaks = new PlayerBreakApplication(__DIR__);
if ($playerBreaks->run()) {
    return;
}

$operations = new TournamentOperationsApplication(__DIR__);
if ($operations->run()) {
    return;
}

$seasons = new SeasonApplication(__DIR__);
if ($seasons->run()) {
    return;
}

$elo = new EloApplication(__DIR__);
if ($elo->run()) {
    return;
}

$playerIdentity = new PlayerIdentityApplication(__DIR__);
if ($playerIdentity->run()) {
    return;
}

$liveHighlights = new LiveHighlightsApplication(__DIR__);
if ($liveHighlights->run()) {
    return;
}

$playerPortal = new PlayerPortalApplication(__DIR__);
if ($playerPortal->run()) {
    return;
}

$matchScoring = new MatchScoringApplication(__DIR__);
if ($matchScoring->run()) {
    return;
}

$app = new Application(__DIR__);
$app->run();