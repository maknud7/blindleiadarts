<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

// The release workflow replaces this placeholder only in dist/test with a fresh
// one-time digest. No usable operational key is ever committed to the repository.
$expectedKeyHash = '__OWNER_RESET_KEY_HASH__';
$providedKey = trim((string) ($_GET['key'] ?? ''));
if ($providedKey === '' || !hash_equals($expectedKeyHash, hash('sha256', $providedKey))) {
    $respond(['ok' => false, 'error' => ['code' => 'not_found', 'message' => 'Ikke tilgjengelig.']], 404);
}

$marker = __DIR__ . '/data/.owner-onboarding-reset-20260825-used';
if (is_file($marker)) {
    $respond(['ok' => true, 'data' => ['status' => 'already_used']]);
}

try {
    $config = Config::load(__DIR__);
    if ($config->appEnv() !== 'test') {
        throw new RuntimeException('Operasjonen er bare tillatt fra testmiljøet.');
    }

    $database = new Database($config);
    $db = $database->connection();
    $identityPrefix = $database->identityTablePrefix();
    $dataPrefix = $database->tablePrefix();
    if (!preg_match('/^[A-Za-z0-9_]+$/', $identityPrefix) || !preg_match('/^[A-Za-z0-9_]+$/', $dataPrefix)) {
        throw new RuntimeException('Ugyldig tabellprefiks.');
    }
    if ($identityPrefix !== 'bd_prod_') {
        throw new RuntimeException('Testmiljøet peker ikke på canonical brukeridentitet.');
    }

    $users = $identityPrefix . 'user_accounts';
    $roles = $identityPrefix . 'global_user_roles';
    $sessions = $identityPrefix . 'auth_sessions';
    $invitations = $identityPrefix . 'user_onboarding_invitations';
    $legacyUsers = $dataPrefix . 'user_accounts';
    $displayName = 'Magnus Knudsen';

    $stmt = $db->prepare(
        "SELECT ua.id, ua.member_id, ua.email, ua.username, ua.display_name
           FROM `{$users}` ua
           INNER JOIN `{$roles}` gur ON gur.user_account_id=ua.id AND gur.role='super_admin'
          WHERE ua.display_name=?
          LIMIT 2"
    );
    $stmt->bind_param('s', $displayName);
    $stmt->execute();
    $result = $stmt->get_result();
    $accounts = [];
    while ($row = $result->fetch_assoc()) $accounts[] = $row;
    $stmt->close();

    if (count($accounts) !== 1) {
        throw new RuntimeException('Fant ikke nøyaktig én canonical superadmin-konto.');
    }

    $accountId = (int) $accounts[0]['id'];
    $memberId = (int) ($accounts[0]['member_id'] ?? 0);
    if ($memberId <= 0) throw new RuntimeException('Kontoen mangler medlemskobling.');

    // Email is now the canonical login identity. The production row predates that
    // decision, so recover an existing email value conservatively before onboarding:
    // canonical email/legacy username plus the old isolated test account for the exact
    // same member_id. We only proceed when all valid candidates collapse to one address.
    $emailCandidates = [];
    $addEmailCandidate = static function (array &$items, mixed $value): void {
        $candidate = mb_strtolower(trim((string) ($value ?? '')), 'UTF-8');
        if (filter_var($candidate, FILTER_VALIDATE_EMAIL)) $items[$candidate] = true;
    };
    $addEmailCandidate($emailCandidates, $accounts[0]['email'] ?? null);
    $addEmailCandidate($emailCandidates, $accounts[0]['username'] ?? null);

    if ($dataPrefix !== $identityPrefix) {
        $legacy = $db->prepare("SELECT email, username FROM `{$legacyUsers}` WHERE member_id=? LIMIT 2");
        $legacy->bind_param('i', $memberId);
        $legacy->execute();
        $legacyResult = $legacy->get_result();
        while ($row = $legacyResult->fetch_assoc()) {
            $addEmailCandidate($emailCandidates, $row['email'] ?? null);
            $addEmailCandidate($emailCandidates, $row['username'] ?? null);
        }
        $legacy->close();
    }

    $emails = array_keys($emailCandidates);
    if (count($emails) !== 1) {
        throw new RuntimeException(count($emails) === 0
            ? 'Fant ingen eksisterende gyldig e-postadresse for medlemmet.'
            : 'Fant flere ulike e-postadresser for medlemmet; reset stoppet for sikkerhets skyld.');
    }
    $email = $emails[0];

    $member = $db->prepare('SELECT id, navn FROM `medlemmer` WHERE id=? LIMIT 1');
    $member->bind_param('i', $memberId);
    $member->execute();
    $memberRow = $member->get_result()->fetch_assoc() ?: null;
    $member->close();
    if ($memberRow === null) throw new RuntimeException('Canonical medlem finnes ikke.');

    $rawToken = bin2hex(random_bytes(32));
    $tokenHash = hash('sha256', $rawToken);
    $expiresAt = (new DateTimeImmutable('+14 days'))->format('Y-m-d H:i:s');
    $activationUrl = 'https://test.blindleiadarts.ingenting.org/onboarding/?token=' . rawurlencode($rawToken);

    $db->begin_transaction();
    try {
        $lock = $db->prepare("SELECT id, member_id FROM `{$users}` WHERE id=? FOR UPDATE");
        $lock->bind_param('i', $accountId);
        $lock->execute();
        $locked = $lock->get_result()->fetch_assoc() ?: null;
        $lock->close();
        if ($locked === null || (int) ($locked['member_id'] ?? 0) !== $memberId) {
            throw new RuntimeException('Kontoen endret seg under reset.');
        }

        $revokeInvites = $db->prepare(
            "UPDATE `{$invitations}` SET revoked_at=NOW()
              WHERE user_account_id=? AND used_at IS NULL AND revoked_at IS NULL"
        );
        $revokeInvites->bind_param('i', $accountId);
        $revokeInvites->execute();
        $revokeInvites->close();

        $revokeSessions = $db->prepare(
            "UPDATE `{$sessions}` SET revoked_at=NOW()
              WHERE user_account_id=? AND revoked_at IS NULL"
        );
        $revokeSessions->bind_param('i', $accountId);
        $revokeSessions->execute();
        $revokeSessions->close();

        foreach (array_unique([$dataPrefix, $identityPrefix]) as $prefix) {
            $table = $prefix . 'password_reset_tokens';
            $exists = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
            $exists->bind_param('s', $table);
            $exists->execute();
            $hasTable = $exists->get_result()->fetch_assoc() !== null;
            $exists->close();
            if ($hasTable) {
                $delete = $db->prepare("DELETE FROM `{$table}` WHERE user_account_id=?");
                $delete->bind_param('i', $accountId);
                $delete->execute();
                $delete->close();
            }
        }

        $status = 'invited';
        $update = $db->prepare(
            "UPDATE `{$users}`
                SET email=?,
                    username=?,
                    password_hash=NULL,
                    account_status=?,
                    is_active=0,
                    invited_at=NOW(),
                    claimed_at=NULL
              WHERE id=?"
        );
        $update->bind_param('sssi', $email, $email, $status, $accountId);
        $update->execute();
        $update->close();

        $insert = $db->prepare(
            "INSERT INTO `{$invitations}`
                (user_account_id, member_id, token_hash, created_by_user_account_id, expires_at)
             VALUES (?, ?, ?, ?, ?)"
        );
        $insert->bind_param('iisis', $accountId, $memberId, $tokenHash, $accountId, $expiresAt);
        $insert->execute();
        $insert->close();

        $subject = 'Aktiver kontoen din - Blindleia Darts';
        $name = trim((string) ($memberRow['navn'] ?? '')) ?: 'dartspiller';
        $message = "Hei {$name},\n\n"
            . "Kontoen din i Blindleia Darts er nullstilt slik at du kan kjøre onboarding på nytt.\n\n"
            . "Åpne denne lenken innen 14 dager:\n{$activationUrl}\n\n"
            . "Der bekrefter du e-postadressen og velger nytt passord.\n\n"
            . "Blindleia Dartklubb\n";
        $headers = [
            'From: Blindleia Dartklubb <blindleiadartklubb@ingenting.org>',
            'Reply-To: blindleiadartklubb@ingenting.org',
            'Content-Type: text/plain; charset=UTF-8',
            'X-Mailer: Blindleia-Darts',
        ];
        if (!@mail($email, $subject, $message, implode("\r\n", $headers))) {
            throw new RuntimeException('E-postserveren tok ikke imot aktiveringsmeldingen.');
        }

        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    if (@file_put_contents($marker, date(DATE_ATOM) . "\n", LOCK_EX) === false) {
        error_log('Owner onboarding reset completed, but one-time marker could not be written.');
    }

    $respond(['ok' => true, 'data' => [
        'status' => 'reset',
        'email_sent' => true,
        'expires_at' => $expiresAt,
    ]]);
} catch (Throwable $error) {
    $respond(['ok' => false, 'error' => [
        'code' => 'owner_onboarding_reset_failed',
        'message' => $error->getMessage(),
    ]], 500);
}
