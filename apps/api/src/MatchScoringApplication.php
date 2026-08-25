<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\KioskAccessException;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\MatchScoringRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\EloReconciliationService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class MatchScoringApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');

        if ($request->method() !== 'POST'
            || preg_match('#^v1/kiosks/([^/]+)/(start-match|visit|undo)$#', $path) !== 1) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $response = $this->dispatch($request, $path, $config, $database);
        } catch (KioskAccessException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'database_error',
                'Database query failed.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'internal_server_error',
                'Unexpected server error.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    private function dispatch(Request $request, string $path, Config $config, Database $database): JsonResponse
    {
        if (preg_match('#^v1/kiosks/([^/]+)/(start-match|visit|undo)$#', $path, $matches) !== 1) {
            return JsonResponse::error(404, 'route_not_found', 'Scoring route was not found.');
        }

        $kioskCode = urldecode((string) $matches[1]);
        $action = (string) $matches[2];
        $pairingToken = $request->header('x-kiosk-pairing-token');
        $kiosks = new KioskRepository($database);

        // Reuse the established pairing/access rules and public state formatting.
        $before = $kiosks->findKioskStateByCode($kioskCode, $pairingToken);
        if ($before === null) {
            return JsonResponse::error(404, 'kiosk_not_found', 'No kiosk exists for the supplied kiosk code.');
        }

        $kiosk = is_array($before['kiosk'] ?? null) ? $before['kiosk'] : [];
        $kioskId = (int) ($kiosk['id'] ?? 0);
        if ($kioskId <= 0) {
            return JsonResponse::error(409, 'kiosk_state_invalid', 'Kiosk state is missing its canonical id.');
        }

        $scoring = new MatchScoringRepository($database);
        if ($action === 'start-match') {
            $scoring->startMatch($kioskId);
        } elseif ($action === 'visit') {
            $scoring->recordVisit($kioskId, $request->jsonBody());
        } else {
            $scoring->undoLastVisit($kioskId);
        }

        // ELO is derived from canonical match state. Reconciliation makes the
        // ledger idempotent and also repairs a prior interrupted ELO update.
        (new EloReconciliationService($database))->reconcileKiosk($kioskId);

        $state = $kiosks->findKioskStateByCode($kioskCode, $pairingToken);
        if ($state === null) {
            return JsonResponse::error(404, 'kiosk_not_found', 'Kiosk disappeared after the scoring mutation.');
        }

        $this->publishRefreshEvents($config, $state);
        return JsonResponse::ok($state);
    }

    /** @param array<string, mixed> $state */
    private function publishRefreshEvents(Config $config, array $state): void
    {
        if (!$config->realtimePublishEnabled()) {
            return;
        }

        $kiosk = is_array($state['kiosk'] ?? null) ? $state['kiosk'] : [];
        $code = trim((string) ($kiosk['code'] ?? ''));
        $club = is_array($kiosk['club'] ?? null) ? $kiosk['club'] : [];
        $clubId = (int) ($club['id'] ?? 0);

        if ($code !== '') {
            $this->publish($config, ['kiosk:' . $code], $state);
        }
        if ($clubId > 0) {
            // Venue screen reloads canonical screen state when a club snapshot lacks a screen payload.
            $this->publish($config, ['club:' . $clubId], ['refresh' => true, 'reason' => 'match_scoring_changed']);
        }
    }

    /** @param array<int,string> $channels @param array<string,mixed> $payload */
    private function publish(Config $config, array $channels, array $payload): void
    {
        $body = json_encode([
            'secret' => $config->realtimePublishSecret(),
            'channels' => $channels,
            'event' => 'snapshot',
            'payload' => $payload,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($body === false) {
            return;
        }

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\nConnection: close",
                'content' => $body,
                'timeout' => 1.5,
                'ignore_errors' => true,
            ],
        ]);

        try {
            @file_get_contents($config->realtimePublishUrl(), false, $context);
        } catch (Throwable) {
            // Realtime is best effort and must never break canonical scoring.
        }
    }
}
