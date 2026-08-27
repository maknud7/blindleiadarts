<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;

final class IdentityAuditRepository
{
    private mysqli $connection;
    private string $prefix;
    private string $identityPrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $database->tablePrefix();
        $this->identityPrefix = $database->identityTablePrefix();
        foreach ([$this->prefix, $this->identityPrefix] as $prefix) {
            if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
                throw new RuntimeException('Invalid database table prefix.');
            }
        }
    }

    /** @return array<int,array<string,mixed>> */
    public function mergeHistory(int $limit = 150): array
    {
        $limit = max(1, min(500, $limit));
        $merges = $this->prefix . 'player_identity_merges';
        $clubs = $this->prefix . 'clubs';
        $players = $this->prefix . 'players';
        $users = $this->identityPrefix . 'user_accounts';

        if (!$this->tableExists($merges)) return [];

        $userJoin = $this->tableExists($users)
            ? "LEFT JOIN `{$users}` ua ON ua.id=m.merged_by_user_account_id"
            : '';
        $userSelect = $this->tableExists($users)
            ? 'ua.display_name AS merged_by_name, ua.email AS merged_by_email,'
            : 'NULL AS merged_by_name, NULL AS merged_by_email,';

        $sql = "SELECT
                    m.id,m.club_id,m.source_player_id,m.target_player_id,
                    m.source_display_name,m.target_display_name,m.merged_by_user_account_id,
                    m.reason,m.summary_json,m.created_at,
                    c.name AS club_name,
                    sp.member_id AS source_member_id,
                    tp.member_id AS target_member_id,
                    {$userSelect}
                    sp.merged_at AS source_merged_at
                FROM `{$merges}` m
                LEFT JOIN `{$clubs}` c ON c.id=m.club_id
                LEFT JOIN `{$players}` sp ON sp.id=m.source_player_id
                LEFT JOIN `{$players}` tp ON tp.id=m.target_player_id
                {$userJoin}
                ORDER BY m.created_at DESC,m.id DESC
                LIMIT {$limit}";
        $rows = $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);

        foreach ($rows as &$row) {
            foreach (['id','club_id','source_player_id','target_player_id','merged_by_user_account_id','source_member_id','target_member_id'] as $key) {
                $row[$key] = $row[$key] !== null ? (int) $row[$key] : null;
            }
            $summary = [];
            if (is_string($row['summary_json'] ?? null) && $row['summary_json'] !== '') {
                $decoded = json_decode($row['summary_json'], true);
                if (is_array($decoded)) $summary = $decoded;
            }
            unset($row['summary_json']);
            $row['summary'] = $summary;
            $moved = is_array($summary['moved'] ?? null) ? $summary['moved'] : [];
            $row['moved_relations'] = array_sum(array_map('intval', $moved));
            $row['identity_scope'] = ($row['source_member_id'] !== null || $row['target_member_id'] !== null)
                ? 'player_member'
                : 'player';
        }
        unset($row);
        return $rows;
    }

    /** @return array<string,mixed> */
    public function health(): array
    {
        $players = $this->prefix . 'players';
        $clubs = $this->prefix . 'clubs';
        $merges = $this->prefix . 'player_identity_merges';

        $sql = "SELECT p.club_id,c.name AS club_name,LOWER(TRIM(p.display_name)) AS normalized_name,
                       MIN(p.display_name) AS display_name,COUNT(*) AS player_ids,
                       GROUP_CONCAT(p.id ORDER BY p.id SEPARATOR ',') AS ids
                FROM `{$players}` p
                LEFT JOIN `{$clubs}` c ON c.id=p.club_id
                WHERE p.merged_into_player_id IS NULL
                GROUP BY p.club_id,c.name,LOWER(TRIM(p.display_name))
                HAVING COUNT(*) > 1
                ORDER BY c.name,display_name";
        $duplicates = $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
        foreach ($duplicates as &$row) {
            $row['club_id'] = $row['club_id'] !== null ? (int) $row['club_id'] : null;
            $row['player_ids'] = (int) $row['player_ids'];
            $row['ids'] = array_values(array_filter(array_map('intval', explode(',', (string) ($row['ids'] ?? '')))));
        }
        unset($row);

        $mergeCount = 0;
        if ($this->tableExists($merges)) {
            $mergeCount = (int) (($this->connection->query("SELECT COUNT(*) AS c FROM `{$merges}`")->fetch_assoc()['c'] ?? 0));
        }

        return [
            'ok' => $duplicates === [],
            'duplicate_groups' => count($duplicates),
            'duplicate_player_ids' => array_sum(array_map(static fn(array $row): int => (int) $row['player_ids'], $duplicates)),
            'merge_count' => $mergeCount,
            'duplicates' => $duplicates,
        ];
    }

    private function tableExists(string $table): bool
    {
        $statement = $this->connection->prepare(
            'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
        );
        $statement->bind_param('s', $table);
        $statement->execute();
        $exists = $statement->get_result()->fetch_assoc() !== null;
        $statement->close();
        return $exists;
    }
}
