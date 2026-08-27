<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\KioskAccessException;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
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

        // Pairing/access is transport-specific. The actual scoring mutation is not.
        $before = $kiosks->findKioskStateByCode($kioskCode, $pairingToken);
        if ($before === null) {
            return JsonResponse::error(404, 'kiosk_not_found', 'No kiosk exists for the supplied kiosk code.');
        }

        $kiosk = is_array($before['kiosk'] ?? null) ? $before['kiosk'] : [];
        $kioskId = (int) ($kiosk['id'] ?? 0);
        if ($kioskId <= 0) {
            return JsonResponse::error(409, 'kiosk_state_invalid', 'Kiosk state is missing its canonical id.');
        }

        $scoring = new CanonicalScoringService($database, $config);
        if ($action === 'start-match') {
            $scoring->startMatch($kioskId, 'manual');
        } elseif ($action === 'visit') {
            $scoring->recordVisit($kioskId, $request->jsonBody(), 'manual');
        } else {
            $scoring->undoLastVisit($kioskId, 'manual');
        }

        $state = $kiosks->findKioskStateByCode($kioskCode, $pairingToken);
        if ($state === null) {
            return JsonResponse::error(404, 'kiosk_not_found', 'Kiosk disappeared after the scoring mutation.');
        }

        return JsonResponse::ok($state);
    }
}
