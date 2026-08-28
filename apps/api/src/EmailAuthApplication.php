<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\AuthAuditRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

/**
 * Canonical authentication entry point.
 *
 * Email is the only login identifier exposed by the product. The legacy
 * user_accounts.username column remains temporarily for schema compatibility,
 * but it is neither queried nor returned as a separate identity here.
 */
final class EmailAuthApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        $method = $request->method();

        $isLogin = $method === 'POST' && $path === 'v1/auth/login';
        $isMe = $method === 'GET' && $path === 'v1/auth/me';
        if (!$isLogin && !$isMe) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);
            $audit = new AuthAuditRepository($database);
            $response = $isLogin
                ? $this->login($request, $users, $audit)
                : $this->me($request, $users);
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'database_error',
                'Innlogging er midlertidig utilgjengelig.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'internal_server_error',
                'Innlogging er midlertidig utilgjengelig.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    private function login(Request $request, UserAccountRepository $users, AuthAuditRepository $audit): JsonResponse
    {
        $payload = $request->jsonBody();

        // Existing clients may still send the old transport key while they are
        // being upgraded. Its value is nevertheless required to be an email.
        $email = mb_strtolower(trim((string) ($payload['email'] ?? $payload['username'] ?? '')), 'UTF-8');
        $password = (string) ($payload['password'] ?? '');

        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $password === '') {
            $this->recordAudit($audit, null, null, 'login_failed_credentials_required');
            return JsonResponse::error(422, 'credentials_required', 'Skriv inn gyldig e-postadresse og passord.');
        }

        $user = $users->findByEmail($email);
        $userAccountId = $user !== null ? (int) ($user['id'] ?? 0) : 0;
        $clubId = $user !== null && isset($user['player_club_id']) && $user['player_club_id'] !== null
            ? (int) $user['player_club_id']
            : 0;

        if ($user === null || !password_verify($password, (string) ($user['password_hash'] ?? ''))) {
            $this->recordAudit(
                $audit,
                $userAccountId > 0 ? $userAccountId : null,
                $clubId > 0 ? $clubId : null,
                'login_failed_invalid_credentials'
            );
            return JsonResponse::error(401, 'invalid_credentials', 'Ugyldig e-post eller passord.');
        }
        if ((int) ($user['is_active'] ?? 0) !== 1 || (string) ($user['account_status'] ?? 'active') !== 'active') {
            $this->recordAudit(
                $audit,
                $userAccountId > 0 ? $userAccountId : null,
                $clubId > 0 ? $clubId : null,
                'login_failed_account_inactive'
            );
            return JsonResponse::error(403, 'account_inactive', 'Denne kontoen er ikke aktiv.');
        }

        $session = $users->createSession((int) $user['id']);
        $this->recordAudit(
            $audit,
            $userAccountId > 0 ? $userAccountId : null,
            $clubId > 0 ? $clubId : null,
            'login_success'
        );
        return JsonResponse::ok([
            'token_type' => 'Bearer',
            'access_token' => $session['token'],
            'expires_at' => $session['expires_at'],
            'user' => $this->formatUser($user),
        ]);
    }

    private function me(Request $request, UserAccountRepository $users): JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'missing_bearer_token', 'Innlogging kreves.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        return JsonResponse::ok(['user' => $this->formatUser($user)]);
    }

    private function recordAudit(AuthAuditRepository $audit, ?int $userAccountId, ?int $clubId, string $eventName): void
    {
        try {
            $audit->record($userAccountId, $clubId, $eventName);
        } catch (Throwable) {
            // Authentication must never fail because auxiliary audit logging is
            // temporarily unavailable.
        }
    }

    /** @param array<string,mixed> $user @return array<string,mixed> */
    private function formatUser(array $user): array
    {
        $email = $user['email'] ?? $user['contact_email'] ?? null;
        return [
            'id' => isset($user['id']) ? (int) $user['id'] : null,
            'email' => $email,
            // Temporary compatibility alias for already deployed frontend bundles.
            // It contains the email address; there is no separate login name.
            'username' => $email,
            'display_name' => $user['display_name'] ?? null,
            'role' => $user['role'] ?? null,
            'is_super_admin' => ($user['role'] ?? null) === 'super_admin',
            'contact_email' => $email,
            'contact_phone' => $user['contact_phone'] ?? null,
            'player' => [
                'id' => isset($user['player_id']) && $user['player_id'] !== null ? (int) $user['player_id'] : null,
                'display_name' => $user['player_display_name'] ?? null,
                'club_id' => isset($user['player_club_id']) && $user['player_club_id'] !== null ? (int) $user['player_club_id'] : null,
            ],
        ];
    }
}
