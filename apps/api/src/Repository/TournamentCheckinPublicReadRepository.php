<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

/**
 * Public check-in display reads must stay strictly side-effect free.
 *
 * In particular this repository never rotates check-in codes and never touches
 * screen_devices.last_connected_at while resolving a screen token.
 */
final class TournamentCheckinPublicReadRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    public function clubIdForScreenToken(string $accessToken): ?int
    {
        $accessToken = trim($accessToken);
        if ($accessToken === '') return null;

        $stmt = $this->connection->prepare(sprintf(
            'SELECT club_id FROM `%1$sscreen_devices` WHERE access_token=? AND is_active=1 LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('s', $accessToken);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        $clubId = (int) ($row['club_id'] ?? 0);
        return $clubId > 0 ? $clubId : null;
    }

    public function clubIdForSlug(string $slug): ?int
    {
        $slug = trim($slug);
        if ($slug === '') return null;

        $stmt = $this->connection->prepare(sprintf(
            'SELECT id FROM `%1$sclubs` WHERE slug=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('s', $slug);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        $clubId = (int) ($row['id'] ?? 0);
        return $clubId > 0 ? $clubId : null;
    }

    /** @return array<string,mixed>|null */
    public function publicDisplayForClub(int $clubId): ?array
    {
        if ($clubId <= 0) return null;

        $sql = sprintf(
            'SELECT t.id,t.name,t.start_at,t.checkin_code,
                    COALESCE(t.checkin_method,ccs.default_method,"admin_or_code") AS effective_method,
                    COALESCE(
                        t.checkin_opens_at,
                        DATE_SUB(t.start_at, INTERVAL COALESCE(ccs.opens_minutes_before_start,60) MINUTE)
                    ) AS effective_checkin_opens_at
             FROM `%1$stournaments` t
             LEFT JOIN `%1$sclub_checkin_settings` ccs ON ccs.club_id=t.club_id
             WHERE t.club_id=? AND t.status="draft" AND t.start_at IS NOT NULL
               AND t.start_at BETWEEN DATE_SUB(NOW(), INTERVAL 8 HOUR) AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
             ORDER BY ABS(TIMESTAMPDIFF(SECOND,NOW(),t.start_at)),t.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $result = $stmt->get_result();
        $candidates = $result->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $now = $this->databaseNow();
        foreach ($candidates as $candidate) {
            $tournamentId = (int) ($candidate['id'] ?? 0);
            if ($tournamentId <= 0) continue;

            $opensAt = trim((string) ($candidate['effective_checkin_opens_at'] ?? ''));
            if ($opensAt === '' || strtotime($opensAt) === false || $now < strtotime($opensAt)) {
                continue;
            }

            $method = $this->normalizeMethod($candidate['effective_method'] ?? 'admin_or_code');
            if (!$this->methodUsesCode($method)) continue;

            $code = $this->normalizePersistedCode($candidate['checkin_code'] ?? null);
            // Missing/invalid persisted code is a mutation-side configuration
            // problem. A public GET must never self-heal it by writing a code.
            if ($code === null) continue;

            $participants = $this->publicParticipants($tournamentId);
            $checkedIn = 0;
            $registered = 0;
            $waitlisted = 0;
            foreach ($participants as $participant) {
                $status = (string) ($participant['status'] ?? '');
                if ($status === 'checked_in') $checkedIn++;
                elseif ($status === 'registered') $registered++;
                elseif ($status === 'waitlisted') $waitlisted++;
            }

            return [
                'tournament_id' => $tournamentId,
                'tournament_name' => (string) ($candidate['name'] ?? ''),
                'start_at' => $candidate['start_at'] ?? null,
                'code' => $code,
                'opens_at' => $opensAt,
                'closes_at' => null,
                'method' => $method,
                'participants' => $participants,
                'participant_count' => $checkedIn + $registered,
                'checked_in_count' => $checkedIn,
                'registered_count' => $registered,
                'waitlisted_count' => $waitlisted,
            ];
        }

        return null;
    }

    /** @return array<int,array<string,mixed>> */
    private function publicParticipants(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT p.id AS player_id,p.display_name,tp.status,tp.checked_in_at
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             WHERE tp.tournament_id=? AND tp.status IN ("checked_in","registered","waitlisted")
             ORDER BY FIELD(tp.status,"checked_in","registered","waitlisted"),p.display_name ASC',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $result = $stmt->get_result();
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = [
                'player_id' => (int) $row['player_id'],
                'display_name' => (string) $row['display_name'],
                'status' => (string) $row['status'],
                'checked_in_at' => $row['checked_in_at'] ?? null,
            ];
        }
        $stmt->close();
        return $rows;
    }

    private function databaseNow(): int
    {
        $result = $this->connection->query('SELECT UNIX_TIMESTAMP(NOW(3)) AS now_value');
        $row = $result->fetch_assoc() ?: [];
        $value = (int) ($row['now_value'] ?? 0);
        return $value > 0 ? $value : time();
    }

    private function normalizeMethod(mixed $value): string
    {
        $method = strtolower(trim((string) $value));
        return in_array($method, ['admin_or_code', 'admin_only', 'code'], true) ? $method : 'admin_or_code';
    }

    private function methodUsesCode(string $method): bool
    {
        return in_array($method, ['admin_or_code', 'code'], true);
    }

    private function normalizePersistedCode(mixed $value): ?string
    {
        $code = strtoupper(trim((string) ($value ?? '')));
        $code = preg_replace('/[^A-Z0-9]/', '', $code) ?? '';
        return strlen($code) >= 3 && strlen($code) <= 12 ? $code : null;
    }
}
