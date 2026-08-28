<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;

/**
 * Minimal server-side authentication audit log.
 *
 * The audit deliberately stores no password, bearer token, raw IP address or
 * submitted e-mail address. Known accounts are linked through user_account_id;
 * unknown credentials remain anonymous.
 */
final class AuthAuditRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        if (!preg_match('/^[A-Za-z0-9_]+$/', $this->tablePrefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }
    }

    public function record(?int $userAccountId, ?int $clubId, string $eventName): void
    {
        $allowed = [
            'login_success',
            'login_failed_credentials_required',
            'login_failed_invalid_credentials',
            'login_failed_account_inactive',
        ];
        if (!in_array($eventName, $allowed, true)) {
            throw new RuntimeException('Invalid auth audit event.');
        }

        $table = $this->tablePrefix . 'activity_events';
        $surface = 'auth';
        $path = '/api/v1/auth/login';
        $source = json_encode(['source' => 'email_auth'], JSON_UNESCAPED_SLASHES);

        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}`
                (occurred_at,user_account_id,club_id,surface,event_name,path,metadata_json)
             VALUES (NOW(),?,?,?,?,?,?)"
        );
        $statement->bind_param('iissss', $userAccountId, $clubId, $surface, $eventName, $path, $source);
        $statement->execute();
        $statement->close();
    }
}
