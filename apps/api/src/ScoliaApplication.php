<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaHardwareSettingsRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaRoutedEventRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Service\ScoliaScoringService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class ScoliaApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (!$this->handles($request->method(), $path)) return false;

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $repo = new ScoliaRepository($database);
            $hardware = new ScoliaHardwareSettingsRepository($database);
            $routedEvents = new ScoliaRoutedEventRepository($database);
            $service = new ScoliaScoringService(
                $repo,
                new CanonicalScoringService($database, $config),
                new Dart501Rules()
            );
            $users = new UserAccountRepository($database);
            $kiosks = new KioskRepository($database);
            $response = $this->dispatch($request, $path, $config, $repo, $hardware, $routedEvents, $service, $users, $kiosks);
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(500, 'database_error', 'Database query failed.', ['details' => $error->getMessage()]);
        } catch (Throwable $error) {
            $response = JsonResponse::error(500, 'internal_server_error', 'Unexpected server error.', ['details' => $error->getMessage()]);
        }
        $response->send();
        return true;
    }

    private function handles(string $method, string $path): bool
    {
        return str_starts_with($path, 'v1/scolia/')
            || preg_match('#^v1/clubs/\d+/scolia(?:/.*)?$#', $path) === 1
            || preg_match('#^v1/clubs/\d+/kiosks/\d+/scolia(?:/.*)?$#', $path) === 1
            || preg_match('#^v1/kiosks/[^/]+/scolia(?:/.*)?$#', $path) === 1;
    }

    private function dispatch(
        Request $request,
        string $path,
        Config $config,
        ScoliaRepository $repo,
        ScoliaHardwareSettingsRepository $hardware,
        ScoliaRoutedEventRepository $routedEvents,
        ScoliaScoringService $service,
        UserAccountRepository $users,
        KioskRepository $kiosks
    ): JsonResponse {
        $method = $request->method();

        // Bridge-only surface. Access tokens are deliberately returned only here.
        if (str_starts_with($path, 'v1/scolia/bridge/')) {
            if (!$this->bridgeAuthorized($request, $config)) {
                return JsonResponse::error(401, 'scolia_bridge_unauthorized', 'Invalid Scolia bridge secret.');
            }
            if ($method === 'GET' && $path === 'v1/scolia/bridge/config') {
                return JsonResponse::ok(['boards' => $hardware->listBridgeBoards()] + $hardware->scope());
            }
            if ($method === 'POST' && $path === 'v1/scolia/bridge/events') {
                $body = $request->jsonBody();
                $serial = trim((string) ($body['serial_number'] ?? ''));
                $kioskId = (int) ($body['kiosk_id'] ?? 0);
                $message = is_array($body['message'] ?? null) ? $body['message'] : [];
                if ($serial === '' || $kioskId <= 0 || $message === []) {
                    return JsonResponse::error(422, 'scolia_event_invalid', 'serial_number, kiosk_id and message are required.');
                }
                $queued = $routedEvents->enqueueEvent($serial, $kioskId, $message);
                $drain = $service->drain(20);
                return JsonResponse::ok(['event' => $queued, 'drain' => $drain], $queued['duplicate'] ? 200 : 202);
            }
            if ($method === 'POST' && $path === 'v1/scolia/bridge/drain') {
                $limit = max(1, min(100, (int) ($request->jsonBody()['limit'] ?? 50)));
                return JsonResponse::ok($service->drain($limit));
            }
            if ($method === 'POST' && $path === 'v1/scolia/bridge/heartbeat') {
                $body = $request->jsonBody();
                $boards = is_array($body['boards'] ?? null) ? $body['boards'] : [];
                foreach ($boards as $item) {
                    if (!is_array($item)) continue;
                    $kioskId = (int) ($item['kiosk_id'] ?? 0);
                    if ($kioskId > 0) $repo->bridgeHeartbeat($kioskId, (string) ($item['state'] ?? 'connected'));
                }
                return JsonResponse::ok(['updated' => count($boards)]);
            }
            if ($method === 'GET' && preg_match('#^v1/scolia/bridge/commands/(\d+)$#', $path, $m) === 1) {
                return JsonResponse::ok(['items' => $repo->pollCommands((int) $m[1])]);
            }
            if ($method === 'POST' && preg_match('#^v1/scolia/bridge/commands/(\d+)/result$#', $path, $m) === 1) {
                $body = $request->jsonBody();
                $repo->completeCommand((int) $m[1], (string) ($body['result'] ?? 'failed'), isset($body['error']) ? (string) $body['error'] : null);
                return JsonResponse::ok(['command_id' => (int) $m[1]]);
            }
            return JsonResponse::error(404, 'scolia_bridge_route_not_found', 'Unknown bridge route.');
        }

        // Admin: Scolia master settings are always canonical PROD hardware settings.
        // Queue/incidents remain isolated in the active runtime environment.
        if (preg_match('#^v1/clubs/(\d+)/scolia(?:/(.*))?$#', $path, $m) === 1) {
            $clubId = (int) $m[1];
            $admin = $this->requireAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) return $admin;
            $tail = (string) ($m[2] ?? '');
            if ($method === 'GET' && $tail === '') {
                $dashboard = $repo->adminDashboard($clubId);
                $dashboard['settings'] = $hardware->getClubSettings($clubId);
                $dashboard['boards'] = $hardware->listBoards($clubId);
                return JsonResponse::ok(array_merge($dashboard, $hardware->scope()));
            }
            if ($method === 'GET' && $tail === 'settings') {
                return JsonResponse::ok(['settings' => $hardware->getClubSettings($clubId)] + $hardware->scope());
            }
            if (in_array($method, ['PATCH','PUT'], true) && $tail === 'settings') {
                return JsonResponse::ok(['settings' => $hardware->updateClubSettings($clubId, $request->jsonBody(), (int) $admin['id'])] + $hardware->scope());
            }
            if ($method === 'POST' && preg_match('#^incidents/(\d+)/resolve$#', $tail, $i) === 1) {
                return JsonResponse::ok(['resolved' => $repo->resolveIncident($clubId, (int) $i[1], (int) $admin['id'])]);
            }
            if ($method === 'POST' && preg_match('#^events/(\d+)/retry$#', $tail, $e) === 1) {
                $retried = $repo->retryDeadLetter($clubId, (int) $e[1]);
                $drain = $retried ? $service->drain(25) : ['claimed'=>0,'processed'=>0,'failed'=>0];
                return JsonResponse::ok(['retried' => $retried, 'drain' => $drain]);
            }
            if ($method === 'POST' && $tail === 'queue/drain') return JsonResponse::ok($service->drain(100));
            if ($method === 'POST' && $tail === 'cleanup') return JsonResponse::ok(['deleted_events' => $repo->cleanupOldEvents($clubId)]);
            return JsonResponse::error(404, 'scolia_admin_route_not_found', 'Unknown Scolia admin route.');
        }

        // Admin: per-board mapping is canonical PROD master data. Runtime actions
        // target the current environment's kiosk (a TEST alias during test mode).
        if (preg_match('#^v1/clubs/(\d+)/kiosks/(\d+)/scolia(?:/(.*))?$#', $path, $m) === 1) {
            $clubId = (int) $m[1];
            $kioskId = (int) $m[2];
            $admin = $this->requireAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) return $admin;
            $tail = (string) ($m[3] ?? '');

            $canonical = $hardware->getBoardSettings($clubId, $kioskId);
            if ($canonical === null) return JsonResponse::error(404, 'kiosk_not_found', 'Boardet ble ikke funnet.');
            $runtimeId = (int) ($canonical['runtime_kiosk_id'] ?? 0);

            if ($method === 'GET' && $tail === '') {
                $runtime = [];
                if ($runtimeId > 0) {
                    try {
                        $runtime = $repo->getBoardRuntimeStatus($clubId, $runtimeId);
                    } catch (ValidationException) {
                        $runtime = [];
                    }
                }
                return JsonResponse::ok(['board' => array_merge($runtime, $canonical)] + $hardware->scope());
            }
            if (in_array($method, ['PATCH','PUT'], true) && $tail === '') {
                $body = $request->jsonBody();
                if (($body['mode'] ?? null) === 'shadow') $body['mode'] = 'live';
                if (array_key_exists('mode', $body) && !in_array((string) $body['mode'], ['off', 'live'], true)) {
                    return JsonResponse::error(422, 'scolia_mode_invalid', 'Scolia-board kan bare bruke live scoring.');
                }
                if (($body['mode'] ?? null) === 'live') $body['auto_fallback_to_manual'] = true;
                $board = $hardware->updateBoardSettings($clubId, $kioskId, $body, (int) $admin['id']);
                if ($board === null) return JsonResponse::error(404, 'kiosk_not_found', 'Boardet ble ikke funnet.');
                return JsonResponse::ok(['board' => $board] + $hardware->scope());
            }

            if ($runtimeId <= 0) {
                return JsonResponse::error(409, 'scolia_runtime_not_active', 'Denne fysiske skiva har ingen aktiv runtime i dette miljøet.');
            }
            if ($method === 'POST' && $tail === 'fallback') {
                $repo->markDisconnected($runtimeId, 'Manuell fallback aktivert av admin.');
                return JsonResponse::ok(['board' => $repo->getBoardRuntimeStatus($clubId, $runtimeId)]);
            }
            if ($method === 'POST' && $tail === 'resume') {
                $command = $service->resumeAfterReconciliation($clubId, $runtimeId, (int) $admin['id']);
                return JsonResponse::ok(['command' => $command, 'board' => $repo->getBoardRuntimeStatus($clubId, $runtimeId)]);
            }
            if ($method === 'POST' && $tail === 'reset-phase') return JsonResponse::ok(['command' => $service->resetPhase($clubId, $runtimeId, (int) $admin['id'])]);
            return JsonResponse::error(404, 'scolia_board_route_not_found', 'Unknown Scolia board route.');
        }

        // Paired board terminal: status, manual fallback and corrections for the current uncommitted visit.
        if (preg_match('#^v1/kiosks/([^/]+)/scolia(?:/(.*))?$#', $path, $m) === 1) {
            $code = urldecode($m[1]);
            $token = $request->header('x-kiosk-pairing-token');
            $snapshot = $kiosks->findKioskStateByCode($code, $token);
            if ($snapshot === null) return JsonResponse::error(404, 'kiosk_not_found', 'Board-terminalen ble ikke funnet.');
            $kiosk = is_array($snapshot['kiosk'] ?? null) ? $snapshot['kiosk'] : [];
            $kioskId = (int) ($kiosk['id'] ?? 0);
            $clubId = (int) ($kiosk['club']['id'] ?? 0);
            if ($kioskId <= 0 || $clubId <= 0) return JsonResponse::error(409, 'kiosk_context_invalid', 'Board-terminalen mangler klubbkobling.');
            $tail = (string) ($m[2] ?? '');
            if ($method === 'GET' && ($tail === '' || $tail === 'status')) return JsonResponse::ok(['board' => $repo->getBoardRuntimeStatus($clubId, $kioskId)]);
            if ($method === 'POST' && $tail === 'fallback') {
                $repo->markDisconnected($kioskId, 'Manuell fallback aktivert på board-terminalen.');
                return JsonResponse::ok(['board' => $repo->getBoardRuntimeStatus($clubId, $kioskId)]);
            }
            if ($method === 'POST' && $tail === 'resume') {
                $body = $request->jsonBody();
                if (($body['reconciled'] ?? false) !== true) return JsonResponse::error(422, 'reconciliation_confirmation_required', 'Bekreft at score er avstemt før Scolia gjenopptas.');
                return JsonResponse::ok(['command' => $service->resumeAfterReconciliation($clubId, $kioskId, 0)]);
            }
            if ($method === 'POST' && $tail === 'reset-phase') return JsonResponse::ok(['command' => $service->resetPhase($clubId, $kioskId, 0)]);
            if ($method === 'POST' && $tail === 'delete-throw') {
                $body = $request->jsonBody();
                $index = isset($body['throw_index']) ? (int) $body['throw_index'] : null;
                return JsonResponse::ok($service->deleteBufferedThrow($clubId, $kioskId, $index, 0));
            }
            if ($method === 'POST' && $tail === 'correct-throw') {
                $body = $request->jsonBody();
                return JsonResponse::ok($service->correctBufferedThrow($clubId, $kioskId, (int) ($body['throw_index'] ?? -1), (string) ($body['sector'] ?? ''), 0));
            }
            return JsonResponse::error(404, 'scolia_kiosk_route_not_found', 'Unknown Scolia kiosk route.');
        }

        return JsonResponse::error(404, 'scolia_route_not_found', 'Unknown Scolia route.');
    }

    private function bridgeAuthorized(Request $request, Config $config): bool
    {
        $configured = $config->scoliaBridgeSecret();
        $provided = $request->header('x-scolia-bridge-secret') ?? '';
        return $configured !== '' && $provided !== '' && hash_equals($configured, $provided);
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') return JsonResponse::error(403, 'admin_required', 'Club administrator access is required.');
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if (!in_array($clubId, $clubIds, true)) return JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
        return $user;
    }
}
