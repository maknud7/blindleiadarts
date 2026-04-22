<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ClubRepository;
use Blindleia\Dartkiosk\Api\Repository\ConnectorAuthorizationRepository;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentRepository;
use Blindleia\Dartkiosk\Api\Service\ChallongeImportService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeApiClient;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeOAuth;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeOAuthClient;
use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeTournamentProvider;
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

        $clubRepository = new ClubRepository($database);
        $tournamentRepository = new TournamentRepository($database);
        $userRepository = new UserAccountRepository($database);
        $kioskRepository = new KioskRepository($database);

        if ($method === 'GET' && $path === '') {
            return JsonResponse::ok([
                'name' => 'Blindleia Dartkiosk API',
                'environment' => $config->appEnv(),
                'version' => 'v1',
                'routes' => [
                    'GET /v1/health',
                    'POST /v1/auth/login',
                    'GET /v1/auth/me',
                    'GET /v1/me/dashboard',
                    'GET /v1/clubs',
                    'POST /v1/clubs',
                    'GET /v1/clubs/{id}/dashboard',
                    'GET /v1/clubs/{id}/players',
                    'POST /v1/clubs/{id}/players',
                    'GET /v1/clubs/{id}/tournaments',
                    'POST /v1/clubs/{id}/tournaments',
                    'GET /v1/clubs/{id}/kiosks',
                    'POST /v1/clubs/{id}/kiosks',
                    'GET /v1/tournaments/{id}',
                    'GET /v1/tournaments/{id}/matches',
                    'POST /v1/tournaments/{id}/register',
                    'POST /v1/tournaments/{id}/matches',
                    'POST /v1/matches/{id}/assign-kiosk',
                    'GET /v1/kiosks/{code}/state',
                    'POST /v1/kiosks/{code}/start-match',
                    'POST /v1/kiosks/{code}/visit',
                    'POST /v1/kiosks/{code}/undo',
                    'GET /v1/connectors/challonge/authorizations',
                    'GET /v1/connectors/challonge/authorize-url',
                    'GET /v1/connectors/challonge/authorizations/{id}/tournaments',
                    'GET /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/participants',
                    'GET /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/matches',
                    'POST /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/import',
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

        if ($method === 'POST' && $path === 'v1/auth/login') {
            $payload = $request->jsonBody();
            $username = trim((string) ($payload['username'] ?? ''));
            $password = (string) ($payload['password'] ?? '');

            if ($username === '' || $password === '') {
                return JsonResponse::error(422, 'credentials_required', 'Both username and password are required.');
            }

            $user = $userRepository->findByUsername($username);

            if ($user === null || !password_verify($password, (string) $user['password_hash'])) {
                return JsonResponse::error(401, 'invalid_credentials', 'Invalid username or password.');
            }

            if ((int) ($user['is_active'] ?? 0) !== 1) {
                return JsonResponse::error(403, 'account_inactive', 'This account is inactive.');
            }

            $session = $userRepository->createSession((int) $user['id']);

            return JsonResponse::ok([
                'token_type' => 'Bearer',
                'access_token' => $session['token'],
                'expires_at' => $session['expires_at'],
                'user' => $this->formatUser($user),
            ]);
        }

        if ($method === 'GET' && $path === 'v1/auth/me') {
            $user = $this->requireAuthenticatedUser($request, $userRepository);

            if ($user instanceof JsonResponse) {
                return $user;
            }

            return JsonResponse::ok([
                'user' => $this->formatUser($user),
            ]);
        }

        if ($method === 'GET' && $path === 'v1/me/dashboard') {
            $user = $this->requireAuthenticatedUser($request, $userRepository);

            if ($user instanceof JsonResponse) {
                return $user;
            }

            $dashboard = $tournamentRepository->getMemberDashboard((int) $user['id']);

            return JsonResponse::ok([
                'user' => $this->formatUser($user),
                'dashboard' => $dashboard,
            ]);
        }

        if ($method === 'GET' && $path === 'v1/clubs') {
            return JsonResponse::ok([
                'items' => $clubRepository->listClubs(),
            ]);
        }

        if ($method === 'POST' && $path === 'v1/clubs') {
            $admin = $this->requireAdminUser($request, $userRepository);

            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $payload = $request->jsonBody();
            $name = trim((string) ($payload['name'] ?? ''));

            if ($name === '') {
                return JsonResponse::error(422, 'club_name_required', 'Club name is required.');
            }

            return JsonResponse::ok([
                'club' => $clubRepository->createClub($payload),
            ], 201);
        }

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/dashboard$#', $path, $matches) === 1) {
            $dashboard = $clubRepository->getDashboard((int) $matches[1]);

            if ($dashboard === null) {
                return JsonResponse::error(404, 'club_not_found', 'Club was not found.');
            }

            return JsonResponse::ok($dashboard);
        }

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/players$#', $path, $matches) === 1) {
            return JsonResponse::ok([
                'club_id' => (int) $matches[1],
                'items' => $clubRepository->listPlayersByClubId((int) $matches[1]),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/players$#', $path, $matches) === 1) {
            $admin = $this->requireAdminUser($request, $userRepository);

            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $payload = $request->jsonBody();
            $displayName = trim((string) ($payload['display_name'] ?? ''));

            if ($displayName === '') {
                return JsonResponse::error(422, 'player_name_required', 'Player display name is required.');
            }

            return JsonResponse::ok([
                'player' => $clubRepository->createPlayer((int) $matches[1], $payload),
            ], 201);
        }

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/tournaments$#', $path, $matches) === 1) {
            return JsonResponse::ok([
                'club_id' => (int) $matches[1],
                'items' => $tournamentRepository->listByClubId((int) $matches[1]),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/tournaments$#', $path, $matches) === 1) {
            $admin = $this->requireAdminUser($request, $userRepository);

            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $payload = $request->jsonBody();
            $name = trim((string) ($payload['name'] ?? ''));

            if ($name === '') {
                return JsonResponse::error(422, 'tournament_name_required', 'Tournament name is required.');
            }

            $tournament = $tournamentRepository->createTournament((int) $matches[1], $payload);

            return JsonResponse::ok([
                'tournament' => $tournament,
            ], 201);
        }

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/kiosks$#', $path, $matches) === 1) {
            return JsonResponse::ok([
                'club_id' => (int) $matches[1],
                'items' => $clubRepository->listKiosksByClubId((int) $matches[1]),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/kiosks$#', $path, $matches) === 1) {
            $admin = $this->requireAdminUser($request, $userRepository);

            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $payload = $request->jsonBody();
            $code = trim((string) ($payload['code'] ?? ''));

            if ($code === '') {
                return JsonResponse::error(422, 'kiosk_code_required', 'Kiosk code is required.');
            }

            return JsonResponse::ok([
                'kiosk' => $clubRepository->createKiosk((int) $matches[1], $payload),
            ], 201);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)$#', $path, $matches) === 1) {
            $tournament = $tournamentRepository->findById((int) $matches[1]);

            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }

            return JsonResponse::ok([
                'tournament' => $tournament,
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/matches$#', $path, $matches) === 1) {
            return JsonResponse::ok([
                'tournament_id' => (int) $matches[1],
                'items' => $tournamentRepository->listMatches((int) $matches[1]),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/register$#', $path, $matches) === 1) {
            $user = $this->requireAuthenticatedUser($request, $userRepository);

            if ($user instanceof JsonResponse) {
                return $user;
            }

            $playerId = isset($user['player_id']) && $user['player_id'] !== null ? (int) $user['player_id'] : 0;

            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_profile_missing', 'This account is not linked to a player profile.');
            }

            return JsonResponse::ok([
                'registration' => $tournamentRepository->registerPlayer((int) $matches[1], $playerId),
            ], 201);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/matches$#', $path, $matches) === 1) {
            $admin = $this->requireAdminUser($request, $userRepository);

            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $payload = $request->jsonBody();
            $playerAId = (int) ($payload['player_a_id'] ?? 0);
            $playerBId = (int) ($payload['player_b_id'] ?? 0);

            if ($playerAId <= 0 || $playerBId <= 0 || $playerAId === $playerBId) {
                return JsonResponse::error(422, 'invalid_match_players', 'Two distinct players are required to create a match.');
            }

            return JsonResponse::ok([
                'match' => $tournamentRepository->createMatch((int) $matches[1], $payload),
            ], 201);
        }

        if ($method === 'POST' && preg_match('#^v1/matches/(\d+)/assign-kiosk$#', $path, $matches) === 1) {
            $admin = $this->requireAdminUser($request, $userRepository);

            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $payload = $request->jsonBody();
            $kioskId = (int) ($payload['kiosk_id'] ?? 0);

            if ($kioskId <= 0) {
                return JsonResponse::error(422, 'kiosk_required', 'kiosk_id is required.');
            }

            $match = $tournamentRepository->assignMatchToKiosk((int) $matches[1], $kioskId);

            if ($match === null) {
                return JsonResponse::error(404, 'match_not_found', 'Match was not found.');
            }

            return JsonResponse::ok([
                'match' => $match,
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/kiosks/([^/]+)/state$#', $path, $matches) === 1) {
            $kioskCode = urldecode($matches[1]);
            $state = $kioskRepository->findKioskStateByCode($kioskCode);

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

        if ($method === 'POST' && preg_match('#^v1/kiosks/([^/]+)/start-match$#', $path, $matches) === 1) {
            $state = $kioskRepository->startAssignedMatchByCode(urldecode($matches[1]));

            if ($state === null) {
                return JsonResponse::error(404, 'kiosk_not_found', 'No kiosk exists for the supplied kiosk code.');
            }

            return JsonResponse::ok($state);
        }

        if ($method === 'POST' && preg_match('#^v1/kiosks/([^/]+)/visit$#', $path, $matches) === 1) {
            $payload = $request->jsonBody();
            $state = $kioskRepository->recordVisitByCode(urldecode($matches[1]), $payload);

            if ($state === null) {
                return JsonResponse::error(404, 'kiosk_not_found', 'No kiosk exists for the supplied kiosk code.');
            }

            return JsonResponse::ok($state);
        }

        if ($method === 'POST' && preg_match('#^v1/kiosks/([^/]+)/undo$#', $path, $matches) === 1) {
            $state = $kioskRepository->undoLastVisitByCode(urldecode($matches[1]));

            if ($state === null) {
                return JsonResponse::error(404, 'kiosk_not_found', 'No kiosk exists for the supplied kiosk code.');
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

        if ($method === 'GET' && $path === 'v1/connectors/challonge/authorizations') {
            $repository = new ConnectorAuthorizationRepository($database);

            return JsonResponse::ok([
                'items' => $repository->listByProvider('challonge'),
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
                return JsonResponse::error(422, 'authorization_code_required', 'Query parameter code is required.');
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

        if (preg_match('#^v1/connectors/challonge/authorizations/(\d+)/tournaments$#', $path, $matches) === 1) {
            $authorization = $this->requireAuthorization($database, (int) $matches[1]);

            if ($authorization instanceof JsonResponse) {
                return $authorization;
            }

            $provider = new ChallongeTournamentProvider(new ChallongeApiClient($config->challonge()));

            return JsonResponse::ok([
                'authorization_id' => (int) $authorization['id'],
                'items' => $provider->listTournaments((string) $authorization['access_token']),
            ]);
        }

        if (preg_match('#^v1/connectors/challonge/authorizations/(\d+)/tournaments/([^/]+)/participants$#', $path, $matches) === 1) {
            $authorization = $this->requireAuthorization($database, (int) $matches[1]);

            if ($authorization instanceof JsonResponse) {
                return $authorization;
            }

            $provider = new ChallongeTournamentProvider(new ChallongeApiClient($config->challonge()));

            return JsonResponse::ok([
                'authorization_id' => (int) $authorization['id'],
                'tournament_id' => urldecode($matches[2]),
                'items' => $provider->listParticipants((string) $authorization['access_token'], urldecode($matches[2])),
            ]);
        }

        if (preg_match('#^v1/connectors/challonge/authorizations/(\d+)/tournaments/([^/]+)/matches$#', $path, $matches) === 1) {
            $authorization = $this->requireAuthorization($database, (int) $matches[1]);

            if ($authorization instanceof JsonResponse) {
                return $authorization;
            }

            $provider = new ChallongeTournamentProvider(new ChallongeApiClient($config->challonge()));

            return JsonResponse::ok([
                'authorization_id' => (int) $authorization['id'],
                'tournament_id' => urldecode($matches[2]),
                'items' => $provider->listMatches((string) $authorization['access_token'], urldecode($matches[2])),
            ]);
        }

        if (
            $method === 'POST'
            && preg_match('#^v1/connectors/challonge/authorizations/(\d+)/tournaments/([^/]+)/import$#', $path, $matches) === 1
        ) {
            $authorization = $this->requireAuthorization($database, (int) $matches[1]);

            if ($authorization instanceof JsonResponse) {
                return $authorization;
            }

            $provider = new ChallongeTournamentProvider(new ChallongeApiClient($config->challonge()));
            $tournamentId = urldecode($matches[2]);
            $accessToken = (string) $authorization['access_token'];

            $tournament = $provider->getTournament($accessToken, $tournamentId);
            $participants = $provider->listParticipants($accessToken, $tournamentId);
            $matchesData = $provider->listMatches($accessToken, $tournamentId);

            $importService = new ChallongeImportService($database);
            $summary = $importService->importTournament($tournament, $participants, $matchesData);

            return JsonResponse::ok([
                'provider' => 'challonge',
                'authorization_id' => (int) $authorization['id'],
                'tournament_id' => $tournamentId,
                'import_summary' => $summary,
            ], 201);
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
     * @return array<string, mixed>|JsonResponse
     */
    private function requireAuthenticatedUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();

        if ($token === null) {
            return JsonResponse::error(
                401,
                'missing_bearer_token',
                'Authorization header with Bearer token is required.'
            );
        }

        $user = $users->findBySessionToken($token);

        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Session token is invalid or expired.');
        }

        return $user;
    }

    /**
     * @return array<string, mixed>|JsonResponse
     */
    private function requireAdminUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $user = $this->requireAuthenticatedUser($request, $users);

        if ($user instanceof JsonResponse) {
            return $user;
        }

        if (($user['role'] ?? 'player') !== 'admin') {
            return JsonResponse::error(403, 'admin_required', 'Admin role is required for this endpoint.');
        }

        return $user;
    }

    /**
     * @return array<string, mixed>|JsonResponse
     */
    private function requireAuthorization(Database $database, int $authorizationId): array|JsonResponse
    {
        $repository = new ConnectorAuthorizationRepository($database);
        $authorization = $repository->findById($authorizationId);

        if ($authorization === null || (string) ($authorization['provider_key'] ?? '') !== 'challonge') {
            return JsonResponse::error(
                404,
                'authorization_not_found',
                'No Challonge authorization exists for the supplied id.'
            );
        }

        return $authorization;
    }

    /**
     * @param array<string, mixed> $user
     * @return array<string, mixed>
     */
    private function formatUser(array $user): array
    {
        return [
            'id' => isset($user['id']) ? (int) $user['id'] : null,
            'username' => $user['username'] ?? null,
            'display_name' => $user['display_name'] ?? null,
            'role' => $user['role'] ?? null,
            'contact_email' => $user['contact_email'] ?? null,
            'contact_phone' => $user['contact_phone'] ?? null,
            'player' => [
                'id' => isset($user['player_id']) && $user['player_id'] !== null ? (int) $user['player_id'] : null,
                'display_name' => $user['player_display_name'] ?? null,
            ],
        ];
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
