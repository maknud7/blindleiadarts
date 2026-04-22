<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ConnectorAuthorizationRepository;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeApiClient;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeOAuth;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeOAuthClient;
use DateInterval;
use DateTimeImmutable;
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
        $config = null;

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
                    'details' => $this->shouldExposeDetails($config) ? $exception->getMessage() : null,
                    'exception' => $this->shouldExposeDetails($config) ? $exception::class : null,
                ]
            );
        } catch (Throwable $exception) {
            $response = JsonResponse::error(
                500,
                'internal_server_error',
                'Unexpected server error.',
                [
                    'details' => $this->shouldExposeDetails($config) ? $exception->getMessage() : null,
                    'exception' => $this->shouldExposeDetails($config) ? $exception::class : null,
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
                    'GET /v1/connectors/challonge/authorize-url',
                    'GET /v1/connectors/challonge/callback',
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

        if ($method === 'GET' && $path === 'v1/connectors/challonge/authorize-url') {
            $challonge = $config->challonge();

            if (!$challonge->isConfigured()) {
                return JsonResponse::error(
                    503,
                    'challonge_not_configured',
                    'Challonge OAuth credentials are not configured on the server.'
                );
            }

            $redirectUri = isset($_GET['redirect_uri']) ? trim((string) $_GET['redirect_uri']) : '';

            $scopes = isset($_GET['scopes'])
                ? array_values(array_filter(array_map('trim', explode(',', (string) $_GET['scopes']))))
                : [];

            $communityId = isset($_GET['community_id']) ? trim((string) $_GET['community_id']) : null;
            $stateToken = isset($_GET['state']) ? trim((string) $_GET['state']) : null;

            $oauth = new ChallongeOAuth($challonge);
            $resolvedRedirectUri = $oauth->resolveRedirectUri($redirectUri);

            if ($resolvedRedirectUri === '') {
                return JsonResponse::error(
                    503,
                    'challonge_redirect_uri_not_configured',
                    'Challonge redirect URI is not configured.'
                );
            }

            return JsonResponse::ok([
                'provider' => 'challonge',
                'authorize_url' => $oauth->buildAuthorizationUrl($resolvedRedirectUri, $scopes, $communityId, $stateToken),
                'redirect_uri' => $resolvedRedirectUri,
                'scopes' => $scopes !== [] ? $scopes : $challonge->defaultScopes(),
            ]);
        }

        if ($method === 'GET' && $path === 'v1/connectors/challonge/callback') {
            $challonge = $config->challonge();

            if (!$challonge->isConfigured()) {
                return JsonResponse::error(
                    503,
                    'challonge_not_configured',
                    'Challonge OAuth credentials are not configured on the server.'
                );
            }

            $code = isset($_GET['code']) ? trim((string) $_GET['code']) : '';
            $error = isset($_GET['error']) ? trim((string) $_GET['error']) : '';

            if ($error !== '') {
                return JsonResponse::error(
                    400,
                    'challonge_oauth_error',
                    'Challonge returned an OAuth error.',
                    [
                        'error' => $error,
                        'error_description' => isset($_GET['error_description']) ? (string) $_GET['error_description'] : null,
                    ]
                );
            }

            if ($code === '') {
                return JsonResponse::error(
                    422,
                    'authorization_code_required',
                    'Query parameter code is required.'
                );
            }

            $oauth = new ChallongeOAuth($challonge);
            $oauthClient = new ChallongeOAuthClient($challonge);
            $tokenPayload = $oauthClient->exchangeAuthorizationCode($code, $oauth->resolveRedirectUri());

            $accessToken = isset($tokenPayload['access_token']) ? (string) $tokenPayload['access_token'] : '';

            if ($accessToken === '') {
                return JsonResponse::error(
                    502,
                    'challonge_token_missing',
                    'Challonge did not return an access token.',
                    ['payload' => $tokenPayload]
                );
            }

            $apiClient = new ChallongeApiClient($challonge);
            $me = $apiClient->get('/me.json', $accessToken);

            $userData = is_array($me['data'] ?? null) ? $me['data'] : [];
            $userAttributes = is_array($userData['attributes'] ?? null) ? $userData['attributes'] : [];
            $expiresAt = $this->resolveExpiresAt($tokenPayload);

            $authorizationRepository = new ConnectorAuthorizationRepository($database);
            $authorizationId = $authorizationRepository->storeOAuthAuthorization(
                'challonge',
                isset($userData['id']) ? (string) $userData['id'] : null,
                isset($userAttributes['username']) ? (string) $userAttributes['username'] : null,
                $accessToken,
                isset($tokenPayload['refresh_token']) ? (string) $tokenPayload['refresh_token'] : null,
                isset($tokenPayload['token_type']) ? (string) $tokenPayload['token_type'] : null,
                isset($tokenPayload['scope']) ? (string) $tokenPayload['scope'] : null,
                $expiresAt,
                [
                    'token' => $tokenPayload,
                    'me' => $me,
                ]
            );

            return JsonResponse::ok([
                'provider' => 'challonge',
                'authorization_id' => $authorizationId,
                'account' => [
                    'id' => $userData['id'] ?? null,
                    'username' => $userAttributes['username'] ?? null,
                    'email' => $userAttributes['email'] ?? null,
                ],
                'scope' => $tokenPayload['scope'] ?? null,
                'expires_at' => $expiresAt?->format(DATE_ATOM),
                'message' => 'Challonge authorization stored successfully.',
            ]);
        }

        return JsonResponse::error(404, 'not_found', 'The requested endpoint was not found.');
    }

    private function isDebug(): bool
    {
        return isset($_GET['debug']) && $_GET['debug'] === '1';
    }

    private function shouldExposeDetails(?Config $config): bool
    {
        if ($this->isDebug()) {
            return true;
        }

        return $config instanceof Config && $config->appEnv() !== 'prod';
    }

    /**
     * @param array<string, mixed> $tokenPayload
     */
    private function resolveExpiresAt(array $tokenPayload): ?DateTimeImmutable
    {
        if (!isset($tokenPayload['expires_in'])) {
            return null;
        }

        $expiresIn = (int) $tokenPayload['expires_in'];

        if ($expiresIn <= 0) {
            return null;
        }

        return (new DateTimeImmutable())->add(new DateInterval('PT' . $expiresIn . 'S'));
    }
}
