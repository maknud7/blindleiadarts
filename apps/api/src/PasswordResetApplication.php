<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli_sql_exception;
use Throwable;

final class PasswordResetApplication
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

        if ($method !== 'POST' || !in_array($path, [
            'v1/auth/password-reset/request',
            'v1/auth/password-reset/confirm',
        ], true)) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $response = $path === 'v1/auth/password-reset/request'
                ? $this->requestReset($request, $database)
                : $this->confirmReset($request, $database);
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'database_error',
                'Kunne ikke behandle passordforespørselen nå.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'internal_server_error',
                'Kunne ikke behandle passordforespørselen nå.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    private function requestReset(Request $request, Database $database): JsonResponse
    {
        $payload = $request->jsonBody();
        $email = mb_strtolower(trim((string) ($payload['email'] ?? '')), 'UTF-8');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return JsonResponse::error(422, 'reset_email_required', 'Skriv inn en gyldig e-postadresse.');
        }

        $db = $database->connection();
        $identityPrefix = $this->safePrefix($database->identityTablePrefix());
        $dataPrefix = $this->safePrefix($database->tablePrefix());
        $users = $identityPrefix . 'user_accounts';
        $tokens = $dataPrefix . 'password_reset_tokens';

        $statement = $db->prepare(
            "SELECT id, email, display_name, is_active, account_status
               FROM `{$users}`
              WHERE LOWER(email) = LOWER(?)
              LIMIT 1"
        );
        $statement->bind_param('s', $email);
        $statement->execute();
        $user = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        $generic = JsonResponse::ok([
            'message' => 'Hvis e-postadressen er registrert, sender vi en lenke for å velge nytt passord.',
        ]);

        if ($user === null
            || (int) ($user['is_active'] ?? 0) !== 1
            || (string) ($user['account_status'] ?? 'active') !== 'active'
            || !filter_var((string) ($user['email'] ?? ''), FILTER_VALIDATE_EMAIL)) {
            return $generic;
        }

        $userId = (int) $user['id'];

        // Avoid turning this public endpoint into an email flooder. A request made
        // during the cool-down receives the same generic response as every other request.
        $recent = $db->prepare(
            "SELECT id FROM `{$tokens}`
              WHERE user_account_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 60 SECOND)
              ORDER BY id DESC LIMIT 1"
        );
        $recent->bind_param('i', $userId);
        $recent->execute();
        $recentId = (int) ($recent->get_result()->fetch_assoc()['id'] ?? 0);
        $recent->close();
        if ($recentId > 0) {
            return $generic;
        }

        $rawToken = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $rawToken);
        $expiresAt = (new DateTimeImmutable('+30 minutes'))->format('Y-m-d H:i:s');

        $invalidate = $db->prepare("UPDATE `{$tokens}` SET used_at = NOW() WHERE user_account_id = ? AND used_at IS NULL");
        $invalidate->bind_param('i', $userId);
        $invalidate->execute();
        $invalidate->close();

        $insert = $db->prepare(
            "INSERT INTO `{$tokens}` (user_account_id, token_hash, expires_at)
             VALUES (?, ?, ?)"
        );
        $insert->bind_param('iss', $userId, $tokenHash, $expiresAt);
        $insert->execute();
        $insert->close();

        if (!$this->sendResetMail((string) $user['email'], (string) $user['display_name'], $rawToken)) {
            error_log('Blindleia password reset: mail() failed for user_account_id=' . $userId);
        }

        return $generic;
    }

    private function confirmReset(Request $request, Database $database): JsonResponse
    {
        $payload = $request->jsonBody();
        $token = trim((string) ($payload['token'] ?? ''));
        $password = (string) ($payload['password'] ?? '');

        if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
            return JsonResponse::error(422, 'reset_token_invalid', 'Lenken for nytt passord er ugyldig eller utløpt.');
        }
        if (mb_strlen($password, 'UTF-8') < 8) {
            return JsonResponse::error(422, 'password_too_short', 'Passordet må være minst 8 tegn.');
        }

        $db = $database->connection();
        $identityPrefix = $this->safePrefix($database->identityTablePrefix());
        $dataPrefix = $this->safePrefix($database->tablePrefix());
        $users = $identityPrefix . 'user_accounts';
        $sessions = $identityPrefix . 'auth_sessions';
        $tokens = $dataPrefix . 'password_reset_tokens';
        $tokenHash = hash('sha256', $token);

        $db->begin_transaction();
        try {
            $lookup = $db->prepare(
                "SELECT id, user_account_id
                   FROM `{$tokens}`
                  WHERE token_hash = ? AND used_at IS NULL AND expires_at >= NOW()
                  LIMIT 1 FOR UPDATE"
            );
            $lookup->bind_param('s', $tokenHash);
            $lookup->execute();
            $reset = $lookup->get_result()->fetch_assoc() ?: null;
            $lookup->close();

            if ($reset === null) {
                $db->rollback();
                return JsonResponse::error(422, 'reset_token_invalid', 'Lenken for nytt passord er ugyldig eller utløpt.');
            }

            $userId = (int) $reset['user_account_id'];
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
            if (!is_string($passwordHash) || $passwordHash === '') {
                throw new \RuntimeException('Could not hash password.');
            }

            $update = $db->prepare("UPDATE `{$users}` SET password_hash = ?, updated_at = NOW() WHERE id = ? AND is_active = 1");
            $update->bind_param('si', $passwordHash, $userId);
            $update->execute();
            $changed = $update->affected_rows;
            $update->close();
            if ($changed < 1) {
                throw new \RuntimeException('Active user account was not found.');
            }

            $used = $db->prepare("UPDATE `{$tokens}` SET used_at = NOW() WHERE user_account_id = ? AND used_at IS NULL");
            $used->bind_param('i', $userId);
            $used->execute();
            $used->close();

            $revoke = $db->prepare("UPDATE `{$sessions}` SET revoked_at = NOW() WHERE user_account_id = ? AND revoked_at IS NULL");
            $revoke->bind_param('i', $userId);
            $revoke->execute();
            $revoke->close();

            $db->commit();
        } catch (Throwable $error) {
            $db->rollback();
            throw $error;
        }

        return JsonResponse::ok([
            'message' => 'Passordet er endret. Du kan logge inn med e-postadressen og det nye passordet.',
        ]);
    }

    private function sendResetMail(string $email, string $displayName, string $token): bool
    {
        $host = preg_replace('/[^A-Za-z0-9.:-]/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')) ?: 'dart.ingenting.org';
        $url = 'https://' . $host . '/player/?reset_token=' . rawurlencode($token);
        $name = trim($displayName) !== '' ? trim($displayName) : 'dartspiller';
        $subject = 'Nytt passord - Blindleia Darts';
        $message = "Hei {$name},\n\n"
            . "Du har bedt om å velge nytt passord til Blindleia Darts.\n\n"
            . "Åpne denne lenken innen 30 minutter:\n{$url}\n\n"
            . "Hvis du ikke ba om dette, kan du se bort fra e-posten.\n\n"
            . "Blindleia Dartklubb\n";
        $headers = [
            'From: Blindleia Dartklubb <blindleiadartklubb@ingenting.org>',
            'Reply-To: blindleiadartklubb@ingenting.org',
            'Content-Type: text/plain; charset=UTF-8',
            'X-Mailer: Blindleia-Darts',
        ];

        return @mail($email, $subject, $message, implode("\r\n", $headers));
    }

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new \RuntimeException('Invalid database table prefix.');
        }
        return $prefix;
    }
}
