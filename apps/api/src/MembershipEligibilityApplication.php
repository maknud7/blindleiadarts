<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\MembershipEligibilityRepository;
use Blindleia\Dartkiosk\Api\Repository\PaymentSettingsRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class MembershipEligibilityApplication
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
        $isRead = $method === 'GET' && $path === 'v1/me/eligibility';
        $isSelfRegistration = $method === 'POST' && preg_match('#^v1/tournaments/(\d+)/register$#', $path, $matches) === 1;

        if (!$isRead && !$isSelfRegistration) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                $user->send();
                return true;
            }

            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) {
                JsonResponse::error(422, 'player_profile_missing', 'Denne kontoen er ikke koblet til en spillerprofil.')->send();
                return true;
            }

            $eligibilityRepository = new MembershipEligibilityRepository($database);
            $eligibility = $eligibilityRepository->forPlayer($playerId);
            $paymentSettings = new PaymentSettingsRepository($database);
            $eligibility['payment_options'] = $paymentSettings->publicOptions(
                (int) ($eligibility['club_id'] ?? 0),
                (int) ($eligibility['member_id'] ?? 0)
            );

            if ($isRead) {
                $response = JsonResponse::ok(['eligibility' => $eligibility]);
            } else {
                if (($eligibility['can_register'] ?? true) !== true) {
                    $response = JsonResponse::error(
                        403,
                        'membership_payment_required',
                        (string) ($eligibility['message'] ?? 'Kontingenten må ordnes før du kan melde deg på nye turneringer.'),
                        ['eligibility' => $eligibility]
                    );
                } else {
                    $tournaments = new TournamentRepository($database);
                    $response = JsonResponse::ok([
                        'registration' => $tournaments->registerPlayer((int) $matches[1], $playerId),
                        'eligibility' => $eligibility,
                    ], 201);
                }
            }
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'membership_eligibility_database_error',
                'Medlemsstatus er midlertidig utilgjengelig.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'membership_eligibility_internal_error',
                'Medlemsstatus er midlertidig utilgjengelig.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null || trim($token) === '') {
            return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        return $user;
    }
}
