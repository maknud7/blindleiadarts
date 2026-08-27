<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\IdentityAuditRepository;
use Blindleia\Dartkiosk\Api\Repository\PlayerIdentityRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class PlayerIdentityApplication
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

        $globalAction = null;
        if ($method === 'GET' && preg_match('#^v1/player-identities/(history|health)$#', $path, $globalMatches) === 1) {
            $globalAction = (string) $globalMatches[1];
        }

        $clubMatch = preg_match('#^v1/clubs/(\d+)/player-identities/(duplicates|preview|merge)$#', $path, $matches) === 1;
        if ($globalAction === null && !$clubMatch) {
            return false;
        }

        if ($globalAction === null) {
            $clubId = (int) $matches[1];
            $action = (string) $matches[2];
            if (($action === 'duplicates' && $method !== 'GET') || ($action !== 'duplicates' && $method !== 'POST')) {
                JsonResponse::error(405, 'method_not_allowed', 'Metoden er ikke tillatt.')->send();
                return true;
            }
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);

            if ($globalAction !== null) {
                $user = $this->requireSuperAdmin($request, $users);
                if ($user instanceof JsonResponse) {
                    $user->send();
                    return true;
                }
                $audit = new IdentityAuditRepository($database);
                $response = $globalAction === 'history'
                    ? JsonResponse::ok(['items' => $audit->mergeHistory(isset($_GET['limit']) ? (int) $_GET['limit'] : 150)])
                    : JsonResponse::ok($audit->health());
            } else {
                $clubId = (int) $matches[1];
                $action = (string) $matches[2];
                $user = $this->requireManager($request, $users, $clubId);
                if ($user instanceof JsonResponse) {
                    $user->send();
                    return true;
                }

                $identities = new PlayerIdentityRepository($database);
                if ($action === 'duplicates') {
                    $response = JsonResponse::ok([
                        'items' => $identities->duplicateCandidates($clubId),
                    ]);
                } else {
                    $payload = $request->jsonBody();
                    $sourceId = (int) ($payload['source_player_id'] ?? 0);
                    $targetId = (int) ($payload['target_player_id'] ?? 0);
                    if ($action === 'preview') {
                        $response = JsonResponse::ok($identities->preview($clubId, $sourceId, $targetId));
                    } else {
                        $response = JsonResponse::ok($identities->merge(
                            $clubId,
                            $sourceId,
                            $targetId,
                            isset($user['id']) ? (int) $user['id'] : null,
                            isset($payload['reason']) ? (string) $payload['reason'] : null
                        ));
                    }
                }
            }
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(500, 'player_identity_database_error', 'Spilleridentitet er midlertidig utilgjengelig.', [
                'details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
            ]);
        } catch (Throwable $error) {
            $response = JsonResponse::error(500, 'player_identity_internal_error', 'Spilleridentitet er midlertidig utilgjengelig.', [
                'details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
            ]);
        }

        $response->send();
        return true;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireManager(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') {
            return JsonResponse::error(403, 'club_access_denied', 'Du har ikke tilgang til spilleridentitet for denne klubben.');
        }
        $ids = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if (!in_array($clubId, $ids, true)) {
            return JsonResponse::error(403, 'club_access_denied', 'Du har ikke tilgang til spilleridentitet for denne klubben.');
        }
        return $user;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireSuperAdmin(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        if ((string) ($user['role'] ?? '') !== 'super_admin') {
            return JsonResponse::error(403, 'super_admin_required', 'Superadmin-tilgang kreves.');
        }
        return $user;
    }
}
