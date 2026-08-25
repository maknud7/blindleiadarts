<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class PlayerPortalRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    /** @var array<string, array{rating:float,played:int}> */
    private array $eloBaseline = [];

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->loadEloBaseline();
    }

    /** @return array<int, array<string, mixed>> */
    public function listPlayerDirectory(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                p.id,
                p.display_name,
                p.nickname,
                p.avatar_url,
                p.is_active,
                COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS matches_played,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS matches_won,
                COALESCE((SELECT SUM(ms.score_180) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id), 0) AS score_180,
                COALESCE((SELECT MAX(ms.highest_checkout) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id), 0) AS highest_checkout,
                COALESCE((SELECT ROUND(AVG(ms.average), 2) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id AND ms.average IS NOT NULL), 0) AS recorded_average,
                (SELECT rs.points FROM `%1$sranking_snapshots` rs
                  WHERE rs.player_id=p.id AND rs.ranking_type="elo"
                  ORDER BY rs.calculated_at DESC, rs.id DESC LIMIT 1) AS elo_rating,
                (SELECT rs.calculated_at FROM `%1$sranking_snapshots` rs
                  WHERE rs.player_id=p.id AND rs.ranking_type="elo"
                  ORDER BY rs.calculated_at DESC, rs.id DESC LIMIT 1) AS elo_calculated_at
             FROM `%1$splayers` p
             LEFT JOIN `%1$smatches` m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
             WHERE p.club_id=? AND p.is_active=1
             GROUP BY p.id, p.display_name, p.nickname, p.avatar_url, p.is_active
             ORDER BY p.display_name ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            $this->applyEloFallback($row);
            $played = (int) ($row['matches_played'] ?? 0);
            $won = (int) ($row['matches_won'] ?? 0);
            $row['matches_played'] = $played;
            $row['matches_won'] = $won;
            $row['matches_lost'] = max(0, $played - $won);
            $row['win_percentage'] = $played > 0 ? round(($won / $played) * 100, 1) : 0.0;
            $row['score_180'] = (int) ($row['score_180'] ?? 0);
            $row['highest_checkout'] = (int) ($row['highest_checkout'] ?? 0);
            $row['recorded_average'] = (float) ($row['recorded_average'] ?? 0);
        }
        unset($row);

        return $rows;
    }

    /** @return array<string, mixed>|null */
    public function getPlayerProfile(int $playerId): ?array
    {
        $sql = sprintf(
            'SELECT p.id, p.club_id, c.name AS club_name, p.display_name, p.nickname, p.avatar_url, p.is_active
             FROM `%1$splayers` p
             LEFT JOIN `%1$sclubs` c ON c.id=p.club_id
             WHERE p.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $player = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($player === null) {
            return null;
        }

        $statsSql = sprintf(
            'SELECT
                COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS matches_played,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=? THEN m.id END) AS matches_won,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                (SELECT COUNT(*) FROM `%1$slegs` l INNER JOIN `%1$smatches` lm ON lm.id=l.match_id WHERE l.winner_player_id=?) AS legs_won,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id=?) AS visits_logged,
                (SELECT COALESCE(ROUND(AVG(v.score),2),0) FROM `%1$svisits` v WHERE v.player_id=? AND v.is_bust=0) AS visit_average,
                (SELECT COALESCE(MAX(v.score),0) FROM `%1$svisits` v WHERE v.player_id=? AND v.is_bust=0) AS highest_visit,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id=? AND v.score=180 AND v.is_bust=0) AS visits_180,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id=? AND v.score>=140 AND v.score<180 AND v.is_bust=0) AS visits_140_plus,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id=? AND v.score>=100 AND v.score<140 AND v.is_bust=0) AS visits_100_plus,
                (SELECT COALESCE(MAX(ms.highest_checkout),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id=?) AS highest_checkout,
                (SELECT COALESCE(SUM(ms.checkout_hits),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id=?) AS checkout_hits,
                (SELECT COALESCE(SUM(ms.checkout_attempts),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id=?) AS checkout_attempts,
                (SELECT COALESCE(ROUND(AVG(ms.average),2),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id=? AND ms.average IS NOT NULL) AS recorded_average
             FROM `%1$smatches` m
             WHERE m.player_a_id=? OR m.player_b_id=?',
            $this->tablePrefix
        );
        $statsStmt = $this->connection->prepare($statsSql);
        $statsStmt->bind_param(
            'iiiiiiiiiiiiii',
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId,
            $playerId
        );
        $statsStmt->execute();
        $stats = $statsStmt->get_result()->fetch_assoc() ?: [];
        $statsStmt->close();

        $played = (int) ($stats['matches_played'] ?? 0);
        $won = (int) ($stats['matches_won'] ?? 0);
        $draws = (int) ($stats['draws'] ?? 0);
        $stats['matches_played'] = $played;
        $stats['matches_won'] = $won;
        $stats['draws'] = $draws;
        $stats['matches_lost'] = max(0, $played - $won - $draws);
        $stats['win_percentage'] = $played > 0 ? round(($won / $played) * 100, 1) : 0.0;
        $attempts = (int) ($stats['checkout_attempts'] ?? 0);
        $hits = (int) ($stats['checkout_hits'] ?? 0);
        $stats['checkout_percentage'] = $attempts > 0 ? round(($hits / $attempts) * 100, 1) : null;

        $elo = $this->getElo($playerId, (string) $player['display_name']);

        return [
            'player' => $player,
            'elo' => $elo,
            'stats' => $stats,
            'recent_matches' => $this->listRecentMatches($playerId, 12),
            'elo_history' => $this->listEloHistory($playerId, 20),
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public function listEloTable(int $clubId): array
    {
        $rows = $this->listPlayerDirectory($clubId);
        usort($rows, static function (array $a, array $b): int {
            $rating = ((float) ($b['elo_rating'] ?? 1000)) <=> ((float) ($a['elo_rating'] ?? 1000));
            return $rating !== 0 ? $rating : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });
        foreach ($rows as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);
        return $rows;
    }

    /** @return array<string, mixed> */
    public function getTournamentTables(int $tournamentId): array
    {
        $tournamentSql = sprintf(
            'SELECT t.id, t.club_id, t.name, t.status, t.start_at, t.end_at
             FROM `%1$stournaments` t WHERE t.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($tournamentSql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $tournament = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $groupsSql = sprintf(
            'SELECT g.id, g.name, g.sort_order
             FROM `%1$stournament_groups` g WHERE g.tournament_id=? ORDER BY g.sort_order ASC',
            $this->tablePrefix
        );
        $groupsStmt = $this->connection->prepare($groupsSql);
        $groupsStmt->bind_param('i', $tournamentId);
        $groupsStmt->execute();
        $groups = $groupsStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $groupsStmt->close();

        $tables = [];
        foreach ($groups as $group) {
            $groupId = (int) $group['id'];
            $tables[] = [
                'id' => $groupId,
                'name' => $group['name'],
                'sort_order' => (int) $group['sort_order'],
                'rows' => $this->listGroupTableRows($tournamentId, $groupId),
            ];
        }

        if ($tables === []) {
            $tables[] = [
                'id' => null,
                'name' => 'Turnering',
                'sort_order' => 1,
                'rows' => $this->listUngroupedTableRows($tournamentId),
            ];
        }

        return ['tournament' => $tournament, 'groups' => $tables];
    }

    /** @return array<int, array<string, mixed>> */
    public function listPublishedSummaries(int $clubId, int $limit = 12): array
    {
        $limit = max(1, min(50, $limit));
        $sql = sprintf(
            'SELECT s.id, s.tournament_id, s.title, s.body_text, s.published_at, s.updated_at,
                    t.name AS tournament_name, t.start_at, t.status AS tournament_status
             FROM `%1$stournament_summaries` s
             INNER JOIN `%1$stournaments` t ON t.id=s.tournament_id
             WHERE t.club_id=? AND s.status="published"
             ORDER BY COALESCE(s.published_at, s.updated_at) DESC, s.id DESC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<string, mixed>|null */
    public function getTournamentSummary(int $tournamentId, bool $includeDraft = false): ?array
    {
        $sql = sprintf(
            'SELECT s.id, s.tournament_id, s.title, s.body_text, s.status, s.published_at, s.created_at, s.updated_at,
                    t.club_id, t.name AS tournament_name, t.start_at
             FROM `%1$stournament_summaries` s
             INNER JOIN `%1$stournaments` t ON t.id=s.tournament_id
             WHERE s.tournament_id=? %2$s LIMIT 1',
            $this->tablePrefix,
            $includeDraft ? '' : 'AND s.status="published"'
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string, mixed> */
    public function saveTournamentSummary(int $tournamentId, array $payload, int $userId): array
    {
        $title = trim((string) ($payload['title'] ?? ''));
        $body = trim((string) ($payload['body_text'] ?? ''));
        $status = strtolower(trim((string) ($payload['status'] ?? 'draft')));
        if ($title === '' || $body === '') {
            throw new ValidationException('summary_content_required', 'Summary title and text are required.');
        }
        if (!in_array($status, ['draft', 'published'], true)) {
            throw new ValidationException('invalid_summary_status', 'Summary status must be draft or published.');
        }

        $tournamentSql = sprintf('SELECT id FROM `%1$stournaments` WHERE id=? LIMIT 1', $this->tablePrefix);
        $check = $this->connection->prepare($tournamentSql);
        $check->bind_param('i', $tournamentId);
        $check->execute();
        $exists = $check->get_result()->fetch_assoc() !== null;
        $check->close();
        if (!$exists) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $publishedAt = $status === 'published' ? date('Y-m-d H:i:s') : null;
        $sql = sprintf(
            'INSERT INTO `%1$stournament_summaries`
             (tournament_id, title, body_text, status, published_at, created_by_user_account_id, updated_by_user_account_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                title=VALUES(title), body_text=VALUES(body_text), status=VALUES(status),
                published_at=CASE
                    WHEN VALUES(status)="published" THEN COALESCE(`published_at`, VALUES(published_at))
                    ELSE NULL
                END,
                updated_by_user_account_id=VALUES(updated_by_user_account_id), updated_at=NOW()',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('issssii', $tournamentId, $title, $body, $status, $publishedAt, $userId, $userId);
        $stmt->execute();
        $stmt->close();

        return $this->getTournamentSummary($tournamentId, true) ?? [];
    }

    /** @return array<int, array<string, mixed>> */
    private function listGroupTableRows(int $tournamentId, int $groupId): array
    {
        $sql = sprintf(
            'SELECT p.id AS player_id, p.display_name, gp.seed_number,
                COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS played,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS wins,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
                COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
                COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost
             FROM `%1$stournament_group_players` gp
             INNER JOIN `%1$stournament_players` tp ON tp.id=gp.tournament_player_id
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             LEFT JOIN `%1$smatches` m ON m.tournament_id=? AND m.tournament_group_id=? AND (m.player_a_id=p.id OR m.player_b_id=p.id)
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id
             WHERE gp.group_id=?
             GROUP BY p.id, p.display_name, gp.seed_number',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $tournamentId, $groupId, $groupId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $this->normalizeTableRows($rows);
    }

    /** @return array<int, array<string, mixed>> */
    private function listUngroupedTableRows(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT p.id AS player_id, p.display_name, tp.seed AS seed_number,
                COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS played,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS wins,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
                COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
                COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             LEFT JOIN `%1$smatches` m ON m.tournament_id=tp.tournament_id AND (m.player_a_id=p.id OR m.player_b_id=p.id)
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id
             WHERE tp.tournament_id=? AND tp.status IN ("registered","checked_in","eliminated")
             GROUP BY p.id, p.display_name, tp.seed',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $this->normalizeTableRows($rows);
    }

    /** @param array<int, array<string, mixed>> $rows @return array<int, array<string, mixed>> */
    private function normalizeTableRows(array $rows): array
    {
        foreach ($rows as &$row) {
            foreach (['played', 'wins', 'draws', 'losses', 'legs_won', 'legs_lost'] as $field) {
                $row[$field] = (int) ($row[$field] ?? 0);
            }
            $row['points'] = ($row['wins'] * 2) + $row['draws'];
            $row['leg_diff'] = $row['legs_won'] - $row['legs_lost'];
        }
        unset($row);
        usort($rows, static function (array $a, array $b): int {
            foreach (['points', 'leg_diff', 'legs_won'] as $field) {
                $cmp = ((int) $b[$field]) <=> ((int) $a[$field]);
                if ($cmp !== 0) return $cmp;
            }
            return strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });
        foreach ($rows as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);
        return $rows;
    }

    /** @return array<int, array<string, mixed>> */
    private function listRecentMatches(int $playerId, int $limit): array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, t.name AS tournament_name, t.start_at,
                    m.round_label, m.bracket_label, m.status, m.winner_player_id, m.finished_at,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    ms.average, ms.highest_checkout, ms.score_180
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$smatch_statistics` ms ON ms.match_id=m.id AND ms.player_id=?
             WHERE (m.player_a_id=? OR m.player_b_id=?) AND m.status="completed"
             ORDER BY COALESCE(m.finished_at, t.start_at, m.created_at) DESC, m.id DESC
             LIMIT %2$d',
            $this->tablePrefix,
            max(1, min(50, $limit))
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $playerId, $playerId, $playerId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            $row['result'] = $row['winner_player_id'] === null
                ? 'draw'
                : ((int) $row['winner_player_id'] === $playerId ? 'win' : 'loss');
        }
        unset($row);
        return $rows;
    }

    /** @return array<int, array<string, mixed>> */
    private function listEloHistory(int $playerId, int $limit): array
    {
        $sql = sprintf(
            'SELECT rs.id, rs.points AS rating, rs.position, rs.scope_type, rs.tournament_id,
                    t.name AS tournament_name, rs.calculated_at
             FROM `%1$sranking_snapshots` rs
             LEFT JOIN `%1$stournaments` t ON t.id=rs.tournament_id
             WHERE rs.player_id=? AND rs.ranking_type="elo"
             ORDER BY rs.calculated_at DESC, rs.id DESC
             LIMIT %2$d',
            $this->tablePrefix,
            max(1, min(100, $limit))
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array{rating:float,source:string,calculated_at:?string,baseline_played:?int} */
    private function getElo(int $playerId, string $displayName): array
    {
        $sql = sprintf(
            'SELECT points, calculated_at FROM `%1$sranking_snapshots`
             WHERE player_id=? AND ranking_type="elo"
             ORDER BY calculated_at DESC, id DESC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            return [
                'rating' => (float) $row['points'],
                'source' => 'ranking_snapshot',
                'calculated_at' => $row['calculated_at'],
                'baseline_played' => null,
            ];
        }
        $key = mb_strtolower(trim($displayName), 'UTF-8');
        if (isset($this->eloBaseline[$key])) {
            return [
                'rating' => $this->eloBaseline[$key]['rating'],
                'source' => 'mandagsserien_2026_08_24',
                'calculated_at' => null,
                'baseline_played' => $this->eloBaseline[$key]['played'],
            ];
        }
        return ['rating' => 1000.0, 'source' => 'default_1000', 'calculated_at' => null, 'baseline_played' => 0];
    }

    /** @param array<string, mixed> $row */
    private function applyEloFallback(array &$row): void
    {
        if ($row['elo_rating'] !== null) {
            $row['elo_rating'] = (float) $row['elo_rating'];
            $row['elo_source'] = 'ranking_snapshot';
            return;
        }
        $key = mb_strtolower(trim((string) $row['display_name']), 'UTF-8');
        if (isset($this->eloBaseline[$key])) {
            $row['elo_rating'] = $this->eloBaseline[$key]['rating'];
            $row['elo_source'] = 'mandagsserien_2026_08_24';
            $row['baseline_played'] = $this->eloBaseline[$key]['played'];
        } else {
            $row['elo_rating'] = 1000.0;
            $row['elo_source'] = 'default_1000';
            $row['baseline_played'] = 0;
        }
    }

    private function loadEloBaseline(): void
    {
        $path = dirname(__DIR__, 2) . '/data/mandagsserien-elo-2026-08-24.php';
        if (!is_file($path)) return;
        $data = require $path;
        foreach ((array) ($data['players'] ?? []) as $player) {
            $name = mb_strtolower(trim((string) ($player['display_name'] ?? '')), 'UTF-8');
            if ($name === '') continue;
            $this->eloBaseline[$name] = [
                'rating' => (float) ($player['rating'] ?? 1000.0),
                'played' => (int) ($player['played'] ?? 0),
            ];
        }
    }
}
