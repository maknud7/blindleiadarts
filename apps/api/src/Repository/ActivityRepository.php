<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;

final class ActivityRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $identityPrefix;
    /** @var array<string,int|null> */
    private array $clubSlugCache = [];

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $database->tablePrefix();
        $this->identityPrefix = $database->identityTablePrefix();
        foreach ([$this->dataPrefix, $this->identityPrefix] as $prefix) {
            if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
                throw new RuntimeException('Invalid database table prefix.');
            }
        }
    }

    /**
     * @param list<array<string,mixed>> $events
     */
    public function recordBatch(array $events, ?int $userAccountId, ?int $authSessionId): int
    {
        if ($events === []) {
            return 0;
        }

        $table = $this->dataPrefix . 'activity_events';
        $sql = "INSERT INTO `{$table}`
            (occurred_at,user_account_id,auth_session_id,club_id,tournament_id,surface,event_name,path,page_title,device_class,referrer_host,metadata_json)
            VALUES (COALESCE(?,NOW()),?,?,?,?,?,?,?,?,?,?,?)";
        $statement = $this->connection->prepare($sql);
        $count = 0;

        foreach (array_slice($events, 0, 50) as $event) {
            $occurredAt = $this->dateTimeOrNull($event['occurred_at'] ?? null);
            $clubId = $this->positiveIntOrNull($event['club_id'] ?? null);
            if ($clubId === null) {
                $clubSlug = $this->nullableText($event['club_slug'] ?? null, 120);
                if ($clubSlug !== null) {
                    $clubId = $this->resolveClubIdBySlug($clubSlug);
                }
            }
            $tournamentId = $this->positiveIntOrNull($event['tournament_id'] ?? null);
            $surface = $this->shortText($event['surface'] ?? 'unknown', 32, 'unknown');
            $eventName = $this->shortText($event['event_name'] ?? 'event', 64, 'event');
            $path = $this->shortText($event['path'] ?? '/', 255, '/');
            $pageTitle = $this->nullableText($event['page_title'] ?? null, 180);
            $deviceClass = $this->nullableText($event['device_class'] ?? null, 16);
            $referrerHost = $this->nullableText($event['referrer_host'] ?? null, 190);
            $metadata = is_array($event['metadata'] ?? null) ? $this->sanitizeMetadata($event['metadata']) : [];
            $metadataJson = $metadata !== [] ? json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;

            $statement->bind_param(
                'siiiisssssss',
                $occurredAt,
                $userAccountId,
                $authSessionId,
                $clubId,
                $tournamentId,
                $surface,
                $eventName,
                $path,
                $pageTitle,
                $deviceClass,
                $referrerHost,
                $metadataJson
            );
            $statement->execute();
            $count++;
        }
        $statement->close();
        return $count;
    }

    /** @return array<string,mixed> */
    public function summaryByClub(int $clubId, int $days = 30): array
    {
        $days = max(1, min(365, $days));
        $table = $this->dataPrefix . 'activity_events';
        $users = $this->identityPrefix . 'user_accounts';

        $totalsStmt = $this->connection->prepare(
            "SELECT COUNT(*) AS events,
                    SUM(event_name='page_view') AS page_views,
                    COUNT(DISTINCT CASE WHEN user_account_id IS NOT NULL THEN user_account_id END) AS logged_in_users
             FROM `{$table}`
             WHERE club_id=? AND occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)"
        );
        $totalsStmt->bind_param('i', $clubId);
        $totalsStmt->execute();
        $totals = $totalsStmt->get_result()->fetch_assoc() ?: [];
        $totalsStmt->close();

        $surfacesStmt = $this->connection->prepare(
            "SELECT surface, COUNT(*) AS events, SUM(event_name='page_view') AS page_views
             FROM `{$table}`
             WHERE club_id=? AND occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)
             GROUP BY surface ORDER BY events DESC, surface"
        );
        $surfacesStmt->bind_param('i', $clubId);
        $surfacesStmt->execute();
        $surfaces = $surfacesStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $surfacesStmt->close();

        $pathsStmt = $this->connection->prepare(
            "SELECT path, COUNT(*) AS page_views
             FROM `{$table}`
             WHERE club_id=? AND event_name='page_view' AND occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)
             GROUP BY path ORDER BY page_views DESC, path LIMIT 20"
        );
        $pathsStmt->bind_param('i', $clubId);
        $pathsStmt->execute();
        $paths = $pathsStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $pathsStmt->close();

        $recentStmt = $this->connection->prepare(
            "SELECT ae.id,ae.occurred_at,ae.user_account_id,ae.surface,ae.event_name,ae.path,ae.tournament_id,
                    ua.display_name,ua.email
             FROM `{$table}` ae
             LEFT JOIN `{$users}` ua ON ua.id=ae.user_account_id
             WHERE ae.club_id=?
             ORDER BY ae.occurred_at DESC,ae.id DESC LIMIT 100"
        );
        $recentStmt->bind_param('i', $clubId);
        $recentStmt->execute();
        $recent = $recentStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $recentStmt->close();

        return $this->normalizeSummary($days, $totals, $surfaces, $paths, $recent, []);
    }

    /** @return array<string,mixed> */
    public function summaryAll(int $days = 30): array
    {
        $days = max(1, min(365, $days));
        $table = $this->dataPrefix . 'activity_events';
        $users = $this->identityPrefix . 'user_accounts';
        $clubs = $this->dataPrefix . 'clubs';

        $totals = $this->connection->query(
            "SELECT COUNT(*) AS events,
                    SUM(event_name='page_view') AS page_views,
                    COUNT(DISTINCT CASE WHEN user_account_id IS NOT NULL THEN user_account_id END) AS logged_in_users
             FROM `{$table}`
             WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)"
        )->fetch_assoc() ?: [];

        $surfaces = $this->connection->query(
            "SELECT surface, COUNT(*) AS events, SUM(event_name='page_view') AS page_views
             FROM `{$table}`
             WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)
             GROUP BY surface ORDER BY events DESC, surface"
        )->fetch_all(MYSQLI_ASSOC);

        $paths = $this->connection->query(
            "SELECT path, COUNT(*) AS page_views
             FROM `{$table}`
             WHERE event_name='page_view' AND occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)
             GROUP BY path ORDER BY page_views DESC, path LIMIT 30"
        )->fetch_all(MYSQLI_ASSOC);

        $recent = $this->connection->query(
            "SELECT ae.id,ae.occurred_at,ae.user_account_id,ae.club_id,ae.surface,ae.event_name,ae.path,ae.tournament_id,
                    ua.display_name,ua.email,c.name AS club_name
             FROM `{$table}` ae
             LEFT JOIN `{$users}` ua ON ua.id=ae.user_account_id
             LEFT JOIN `{$clubs}` c ON c.id=ae.club_id
             ORDER BY ae.occurred_at DESC,ae.id DESC LIMIT 150"
        )->fetch_all(MYSQLI_ASSOC);

        $clubRows = $this->connection->query(
            "SELECT ae.club_id,c.name AS club_name,COUNT(*) AS events,SUM(ae.event_name='page_view') AS page_views
             FROM `{$table}` ae
             LEFT JOIN `{$clubs}` c ON c.id=ae.club_id
             WHERE ae.occurred_at >= DATE_SUB(NOW(), INTERVAL {$days} DAY)
             GROUP BY ae.club_id,c.name ORDER BY events DESC"
        )->fetch_all(MYSQLI_ASSOC);

        foreach ($clubRows as &$row) {
            $row['club_id'] = $row['club_id'] !== null ? (int) $row['club_id'] : null;
            $row['events'] = (int) ($row['events'] ?? 0);
            $row['page_views'] = (int) ($row['page_views'] ?? 0);
        }
        unset($row);

        return $this->normalizeSummary($days, $totals, $surfaces, $paths, $recent, $clubRows);
    }

    /** @param array<string,mixed> $totals @param array<int,array<string,mixed>> $surfaces @param array<int,array<string,mixed>> $paths @param array<int,array<string,mixed>> $recent @param array<int,array<string,mixed>> $clubs */
    private function normalizeSummary(int $days, array $totals, array $surfaces, array $paths, array $recent, array $clubs): array
    {
        foreach ($surfaces as &$row) {
            $row['events'] = (int) ($row['events'] ?? 0);
            $row['page_views'] = (int) ($row['page_views'] ?? 0);
        }
        unset($row);
        foreach ($paths as &$row) $row['page_views'] = (int) ($row['page_views'] ?? 0);
        unset($row);
        foreach ($recent as &$row) {
            $row['id'] = (int) $row['id'];
            $row['user_account_id'] = $row['user_account_id'] !== null ? (int) $row['user_account_id'] : null;
            $row['club_id'] = isset($row['club_id']) && $row['club_id'] !== null ? (int) $row['club_id'] : null;
            $row['tournament_id'] = $row['tournament_id'] !== null ? (int) $row['tournament_id'] : null;
        }
        unset($row);

        return [
            'days' => $days,
            'totals' => [
                'events' => (int) ($totals['events'] ?? 0),
                'page_views' => (int) ($totals['page_views'] ?? 0),
                'logged_in_users' => (int) ($totals['logged_in_users'] ?? 0),
            ],
            'surfaces' => $surfaces,
            'top_paths' => $paths,
            'recent' => $recent,
            'clubs' => $clubs,
        ];
    }

    private function resolveClubIdBySlug(string $slug): ?int
    {
        $slug = trim(mb_strtolower($slug, 'UTF-8'));
        if ($slug === '') return null;
        if (array_key_exists($slug, $this->clubSlugCache)) return $this->clubSlugCache[$slug];

        $clubs = $this->dataPrefix . 'clubs';
        $statement = $this->connection->prepare("SELECT id FROM `{$clubs}` WHERE slug=? LIMIT 1");
        $statement->bind_param('s', $slug);
        $statement->execute();
        $id = (int) ($statement->get_result()->fetch_assoc()['id'] ?? 0);
        $statement->close();
        $this->clubSlugCache[$slug] = $id > 0 ? $id : null;
        return $this->clubSlugCache[$slug];
    }

    private function positiveIntOrNull(mixed $value): ?int
    {
        $value = is_numeric($value) ? (int) $value : 0;
        return $value > 0 ? $value : null;
    }

    private function dateTimeOrNull(mixed $value): ?string
    {
        $value = trim((string) ($value ?? ''));
        if ($value === '') return null;
        $timestamp = strtotime($value);
        if ($timestamp === false) return null;
        return date('Y-m-d H:i:s', $timestamp);
    }

    private function shortText(mixed $value, int $maxLength, string $fallback): string
    {
        $value = trim((string) $value);
        if ($value === '') $value = $fallback;
        return mb_substr($value, 0, $maxLength, 'UTF-8');
    }

    private function nullableText(mixed $value, int $maxLength): ?string
    {
        $value = trim((string) ($value ?? ''));
        return $value === '' ? null : mb_substr($value, 0, $maxLength, 'UTF-8');
    }

    /** @param array<string,mixed> $metadata @return array<string,mixed> */
    private function sanitizeMetadata(array $metadata): array
    {
        $allowed = ['element_id','element_tag','action','href_path','portal_view','status','source'];
        $clean = [];
        foreach ($allowed as $key) {
            if (!array_key_exists($key, $metadata)) continue;
            $value = $metadata[$key];
            if (is_bool($value) || is_int($value) || is_float($value)) {
                $clean[$key] = $value;
            } elseif (is_string($value)) {
                $clean[$key] = mb_substr($value, 0, 180, 'UTF-8');
            }
        }
        return $clean;
    }
}
