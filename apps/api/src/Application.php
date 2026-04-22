<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class Application
{
    private string $rootPath;

    public function __construct(string $rootPath)
    {
        $this->rootPath = rtrim($rootPath, '/\\');
    }

    public function run(): void
    {
        $request = Request::fromGlobals();

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);

            $response = $this->dispatch($request, $config, $database);
        } catch (mysqli_sql_exception $exception) {
            $response = JsonResponse::error(
                500,
                'database_error',
                'Database query failed.',
                [
                    'details' => $this->isDebug() ? $exception->getMessage() : null,
                ]
            );
        } catch (Throwable $exception) {
            $response = JsonResponse::error(
                500,
                'internal_server_error',
                'Unexpected server error.',
                [
                    'details' => $this->isDebug() ? $exception->getMessage() : null,
                ]
            );
        }

        $response->send();
    }

    private function dispatch(Request $request, Config $config, Database $database): JsonResponse
    {
        $method = $request->method();
        $path = trim($request->path(), '/');

        if ($method === 'GET' && $path === '') {
            return JsonResponse::ok([
                'name' => 'Blindleia Dartkiosk API',
                'environment' => $config->appEnv(),
                'version' => 'v1',
                'routes' => [
                    'GET /v1/health',
                    'GET /v1/kiosks/{code}/state',
                ],
            ]);
        }

        if ($method === 'GET' && $path === 'v1/health') {
            return JsonResponse::ok([
                'status' => 'ok',
                'environment' => $config->appEnv(),
                'database' => [
                    'connected' => $database->ping(),
                    'name' => $config->dbName(),
                    'table_prefix' => $config->dbTablePrefix(),
                ],
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/kiosks/([^/]+)/state$#', $path, $matches) === 1) {
            $repository = new KioskRepository($database);
            $kioskCode = urldecode($matches[1]);
            $state = $repository->findKioskStateByCode($kioskCode);

            if ($state === null) {
                return JsonResponse::error(
                    404,
                    'kiosk_not_found',
                    'No kiosk exists for the supplied kiosk code.',
                    ['kiosk_code' => $kioskCode]
                );
            }

            return JsonResponse::ok($state);
        }

        return JsonResponse::error(404, 'not_found', 'The requested endpoint was not found.');
    }

    private function isDebug(): bool
    {
        return isset($_GET['debug']) && $_GET['debug'] === '1';
    }
}
