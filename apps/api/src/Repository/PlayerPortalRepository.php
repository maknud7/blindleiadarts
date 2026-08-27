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
                p.member_id,
                p.display_name,
                p.nickname,
                p.avatar_url,
                p.is_active,
                COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS matches_played,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS matches_won,
                COALESCE((SELECT SUM(ms.score_180) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id), 0) AS score_180,
                COALESCE((SELECT MAX(ms.highest_checkout) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id), 0) AS highest_checkout,
                COALESCE((SELECT SUM(COALESCE(ms.darts_thrown,0)) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id), 0) AS recorded_darts,
                COALESCE((SELECT ROUND(COALESCE(
                    SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                    AVG(ms.average)
                ), 2) FROM `%1$smatch_statistics` ms WHERE ms.player_id=p.id AND ms.average IS NOT NULL), 0) AS recorded_average,
                (SELECT rs.points FROM `%1$sranking_snapshots` rs
                  WHERE rs.player_id=p.id AND rs.ranking_type="elo"
                  ORDER BY rs.calculated_at DESC, rs.id DESC LIMIT 1) AS elo_rating,
                (SELECT rs.calculated_at FROM `%1$sranking_snapshots` rs
                  WHERE rs.player_id=p.id AND rs.ranking_type="elo"
                  ORDER BY rs.calculated_at DESC, rs.id DESC LIMIT 1) AS elo_calculated_at
             FROM `%1$splayers` p
             LEFT JOIN `%1$smatches` m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
             WHERE p.club_id=? AND p.is_active=1
             GROUP BY p.id, p.member_id, p.display_name, p.nickname, p.avatar_url, p.is_active
             ORDER BY p.display_name ASC, p.id ASC',
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
            $row['recorded_darts'] = (int) ($row['recorded_darts'] ?? 0);
            $row['recorded_average'] = (float) ($row['recorded_average'] ?? 0);
            $row['three_dart_average'] = $row['recorded_average'];
        }
        unset($row);

        return $this->collapseDuplicatePlayerRows($rows);
    }

    /** @return array<string, mixed>|null */
    public function getPlayerProfile(int $playerId): ?array
    {
        $sql = sprintf(
            'SELECT p.id, p.club_id, p.member_id, c.name AS club_name, p.display_name, p.nickname, p.avatar_url, p.is_active
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

        $aliasIds = $this->playerAliasIds($player);
        $idList = implode(',', array_map('intval', $aliasIds));

        $statsSql = sprintf(
            'SELECT
                COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS matches_played,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IN (%2$s) THEN m.id END) AS matches_won,
                COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                (SELECT COUNT(*) FROM `%1$slegs` l INNER JOIN `%1$smatches` lm ON lm.id=l.match_id WHERE l.winner_player_id IN (%2$s)) AS legs_won,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id IN (%2$s)) AS visits_logged,
                (SELECT COALESCE(ROUND(AVG(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END),2),0) FROM `%1$svisits` v WHERE v.player_id IN (%2$s)) AS visit_average,
                (SELECT COALESCE(ROUND(SUM(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END) * 3 / NULLIF(SUM(v.darts_used),0),2),0) FROM `%1$svisits` v WHERE v.player_id IN (%2$s)) AS visit_three_dart_average,
                (SELECT COALESCE(MAX(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END),0) FROM `%1$svisits` v WHERE v.player_id IN (%2$s)) AS highest_visit,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id IN (%2$s) AND v.score=180 AND v.is_bust=0) AS visits_180,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id IN (%2$s) AND v.score>=140 AND v.score<180 AND v.is_bust=0) AS visits_140_plus,
                (SELECT COUNT(*) FROM `%1$svisits` v WHERE v.player_id IN (%2$s) AND v.score>=100 AND v.score<140 AND v.is_bust=0) AS visits_100_plus,
                (SELECT COALESCE(MAX(ms.highest_checkout),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id IN (%2$s)) AS highest_checkout,
                (SELECT COALESCE(SUM(ms.checkout_hits),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id IN (%2$s)) AS checkout_hits,
                (SELECT COALESCE(SUM(ms.checkout_attempts),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id IN (%2$s)) AS checkout_attempts,
                (SELECT COALESCE(ROUND(COALESCE(
                    SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                    AVG(ms.average)
                ),2),0) FROM `%1$smatch_statistics` ms WHERE ms.player_id IN (%2$s) AND ms.average IS NOT NULL) AS recorded_average
             FROM `%1$smatches` m
             WHERE m.player_a_id IN (%2$s) OR m.player_b_id IN (%2$s)',
            $this->tablePrefix,
            $idList
        );
        $stats = $this->connection->query($statsSql)->fetch_assoc() ?: [];

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
        $visitThreeDart = (float) ($stats['visit_three_dart_average'] ?? 0);
        $recordedAverage = (float) ($stats['recorded_average'] ?? 0);
        $stats['three_dart_average'] = $visitThreeDart > 0 ? $visitThreeDart : $recordedAverage;

        $elo = $this->getEloForAliases($aliasIds, (string) $player['display_name']);

        $player['alias_player_ids'] = $aliasIds;
        $player['has_merged_aliases'] = count($aliasIds) > 1;

        return [
            'player' => $player,
            'elo' => $elo,
            'stats' => $stats,
            'recent_matches' => $this->listRecentMatchesForAliases($aliasIds, 12),
            'elo_history' => $this->listEloHistoryForAliases($aliasIds, 20),
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public function listPlayerMatches(int $playerId, int $limit = 100): array
    {
        $profile = $this->basicPlayer($playerId);
        if ($profile === null) {
            throw new ValidationException('player_not_found', 'Player was not found.', 404);
        }
        return $this->listRecentMatchesForAliases($this->playerAliasIds($profile), $limit);
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
            'SELECT t.id, t.club_id, t.season_id, t.name, t.status, t.start_at, t.end_at
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

        return [
            'tournament' => $tournament,
            'groups' => $tables,
            'tie_break_order' => ['leg_difference', 'three_dart_average', 'head_to_head'],
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public function listTournamentMatches(int $tournamentId, int $limit = 250): array
    {
        $limit = max(1, min(500, $limit));
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.tournament_group_id, g.name AS group_name,
                    m.round_label, m.round_number, m.bracket_label, m.status, m.winner_player_id,
                    m.starts_at, m.finished_at, m.kiosk_id, k.board_number,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    msa.legs_won AS player_a_legs, msa.average AS player_a_average,
                    msb.legs_won AS player_b_legs, msb.average AS player_b_average
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$stournament_groups` g ON g.id=m.tournament_group_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
             LEFT JOIN `%1$smatch_statistics` msa ON msa.match_id=m.id AND msa.player_id=m.player_a_id
             LEFT JOIN `%1$smatch_statistics` msb ON msb.match_id=m.id AND msb.player_id=m.player_b_id
             WHERE m.tournament_id=? AND m.status="completed"
             ORDER BY COALESCE(m.round_number,9999) ASC, COALESCE(m.finished_at,m.starts_at,m.created_at) ASC, m.id ASC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            foreach (['id','tournament_id','tournament_group_id','round_number','winner_player_id','kiosk_id','board_number','player_a_id','player_b_id','player_a_legs','player_b_legs'] as $field) {
                if (array_key_exists($field, $row) && $row[$field] !== null) $row[$field] = (int) $row[$field];
            }
            foreach (['player_a_average','player_b_average'] as $field) {
                $row[$field] = $row[$field] !== null ? (float) $row[$field] : null;
            }
        }
        unset($row);
        return $rows;
    }

    /** @return array<string, mixed>|null */
    public function getMatchDetail(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, t.name AS tournament_name, t.season_id,
                    m.tournament_group_id, g.name AS group_name, m.round_label, m.round_number, m.bracket_label,
                    m.status, m.best_of_legs, m.legs_to_win, m.winner_player_id, m.starts_at, m.finished_at,
                    m.kiosk_id, k.board_number,
                    m.player_a_id, pa.display_name AS player_a_name, pa.nickname AS player_a_nickname,
                    m.player_b_id, pb.display_name AS player_b_name, pb.nickname AS player_b_nickname
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$stournament_groups` g ON g.id=m.tournament_group_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
             WHERE m.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $match = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($match === null) return null;

        foreach (['id','tournament_id','season_id','tournament_group_id','round_number','best_of_legs','legs_to_win','winner_player_id','kiosk_id','board_number','player_a_id','player_b_id'] as $field) {
            if (array_key_exists($field, $match) && $match[$field] !== null) $match[$field] = (int) $match[$field];
        }

        $statsSql = sprintf(
            'SELECT ms.player_id, ms.legs_won, ms.average, ms.first_nine_average, ms.darts_thrown,
                    ms.checkout_hits, ms.checkout_attempts, ms.highest_checkout,
                    ms.score_100_plus, ms.score_140_plus, ms.score_180
             FROM `%1$smatch_statistics` ms WHERE ms.match_id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($statsSql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $statsRows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $stats = [];
        foreach ($statsRows as $row) {
            $row['player_id'] = (int) $row['player_id'];
            foreach (['legs_won','darts_thrown','checkout_hits','checkout_attempts','highest_checkout','score_100_plus','score_140_plus','score_180'] as $field) {
                $row[$field] = $row[$field] !== null ? (int) $row[$field] : null;
            }
            foreach (['average','first_nine_average'] as $field) {
                $row[$field] = $row[$field] !== null ? (float) $row[$field] : null;
            }
            $attempts = (int) ($row['checkout_attempts'] ?? 0);
            $row['checkout_percentage'] = $attempts > 0 ? round(((int) ($row['checkout_hits'] ?? 0) / $attempts) * 100, 1) : null;
            $stats[(int) $row['player_id']] = $row;
        }

        $legsSql = sprintf(
            'SELECT l.id, l.leg_number, l.starting_player_id, l.winner_player_id, l.status, l.start_score, l.finished_at,
                    COALESCE(ROUND(SUM(CASE WHEN v.player_id=m.player_a_id AND v.is_bust=0 THEN v.score ELSE 0 END) * 3 /
                        NULLIF(SUM(CASE WHEN v.player_id=m.player_a_id THEN v.darts_used ELSE 0 END),0),2),0) AS player_a_average,
                    COALESCE(ROUND(SUM(CASE WHEN v.player_id=m.player_b_id AND v.is_bust=0 THEN v.score ELSE 0 END) * 3 /
                        NULLIF(SUM(CASE WHEN v.player_id=m.player_b_id THEN v.darts_used ELSE 0 END),0),2),0) AS player_b_average,
                    SUM(CASE WHEN v.player_id=m.player_a_id THEN v.darts_used ELSE 0 END) AS player_a_darts,
                    SUM(CASE WHEN v.player_id=m.player_b_id THEN v.darts_used ELSE 0 END) AS player_b_darts
             FROM `%1$slegs` l
             INNER JOIN `%1$smatches` m ON m.id=l.match_id
             LEFT JOIN `%1$svisits` v ON v.leg_id=l.id
             WHERE l.match_id=?
             GROUP BY l.id,l.leg_number,l.starting_player_id,l.winner_player_id,l.status,l.start_score,l.finished_at,m.player_a_id,m.player_b_id
             ORDER BY l.leg_number ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($legsSql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $legs = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($legs as &$leg) {
            foreach (['id','leg_number','starting_player_id','winner_player_id','start_score','player_a_darts','player_b_darts'] as $field) {
                if (array_key_exists($field, $leg) && $leg[$field] !== null) $leg[$field] = (int) $leg[$field];
            }
            $leg['player_a_average'] = (float) ($leg['player_a_average'] ?? 0);
            $leg['player_b_average'] = (float) ($leg['player_b_average'] ?? 0);
        }
        unset($leg);

        $visitsSql = sprintf(
            'SELECT v.id,v.leg_id,l.leg_number,v.player_id,v.visit_number,v.score,v.darts_used,v.input_mode,
                    v.darts_json,v.is_bust,v.remaining_after,v.created_at
             FROM `%1$svisits` v
             INNER JOIN `%1$slegs` l ON l.id=v.leg_id
             WHERE v.match_id=? ORDER BY l.leg_number ASC,v.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($visitsSql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $visits = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($visits as &$visit) {
            foreach (['id','leg_id','leg_number','player_id','visit_number','score','darts_used','remaining_after'] as $field) {
                $visit[$field] = (int) ($visit[$field] ?? 0);
            }
            $visit['is_bust'] = (int) ($visit['is_bust'] ?? 0) === 1;
            if (is_string($visit['darts_json']) && $visit['darts_json'] !== '') {
                $decoded = json_decode($visit['darts_json'], true);
                $visit['darts'] = is_array($decoded) ? $decoded : [];
            } else {
                $visit['darts'] = [];
            }
            unset($visit['darts_json']);
        }
        unset($visit);

        return [
            'match' => $match,
            'player_a_stats' => $stats[(int) $match['player_a_id']] ?? null,
            'player_b_stats' => $stats[(int) $match['player_b_id']] ?? null,
            'legs' => $legs,
            'visits' => $visits,
        ];
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
                COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
                COALESCE((SELECT ROUND(COALESCE(
                    SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                    AVG(ms.average)
                ),2)
                    FROM `%1$smatch_statistics` ms
                    INNER JOIN `%1$smatches` sm ON sm.id=ms.match_id
                    WHERE ms.player_id=p.id AND sm.tournament_id=? AND sm.tournament_group_id=? AND sm.status="completed" AND ms.average IS NOT NULL),0) AS three_dart_average
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
        $stmt->bind_param('iiiii', $tournamentId, $groupId, $tournamentId, $groupId, $groupId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $this->normalizeTableRows($rows, $tournamentId, $groupId);
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
                COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
                COALESCE((SELECT ROUND(COALESCE(
                    SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                    AVG(ms.average)
                ),2)
                    FROM `%1$smatch_statistics` ms
                    INNER JOIN `%1$smatches` sm ON sm.id=ms.match_id
                    WHERE ms.player_id=p.id AND sm.tournament_id=? AND sm.status="completed" AND ms.average IS NOT NULL),0) AS three_dart_average
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             LEFT JOIN `%1$smatches` m ON m.tournament_id=tp.tournament_id AND (m.player_a_id=p.id OR m.player_b_id=p.id)
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id
             WHERE tp.tournament_id=? AND tp.status IN ("registered","checked_in","eliminated")
             GROUP BY p.id, p.display_name, tp.seed',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $this->normalizeTableRows($rows, $tournamentId, null);
    }

    /** @param array<int, array<string, mixed>> $rows @return array<int, array<string, mixed>> */
    private function normalizeTableRows(array $rows, int $tournamentId, ?int $groupId): array
    {
        foreach ($rows as &$row) {
            foreach (['played', 'wins', 'draws', 'losses', 'legs_won', 'legs_lost'] as $field) {
                $row[$field] = (int) ($row[$field] ?? 0);
            }
            $row['three_dart_average'] = round((float) ($row['three_dart_average'] ?? 0), 2);
            $row['points'] = ($row['wins'] * 2) + $row['draws'];
            $row['leg_diff'] = $row['legs_won'] - $row['legs_lost'];
            $row['head_to_head_points'] = 0;
        }
        unset($row);

        usort($rows, static function (array $a, array $b): int {
            $cmp = ((int) $b['points']) <=> ((int) $a['points']);
            if ($cmp !== 0) return $cmp;
            $cmp = ((int) $b['leg_diff']) <=> ((int) $a['leg_diff']);
            if ($cmp !== 0) return $cmp;
            $cmp = ((float) $b['three_dart_average']) <=> ((float) $a['three_dart_average']);
            return $cmp !== 0 ? $cmp : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });

        $ranked = [];
        for ($index = 0, $count = count($rows); $index < $count;) {
            $bucket = [$rows[$index]];
            $cursor = $index + 1;
            while ($cursor < $count
                && (int) $rows[$cursor]['points'] === (int) $rows[$index]['points']
                && (int) $rows[$cursor]['leg_diff'] === (int) $rows[$index]['leg_diff']
                && abs((float) $rows[$cursor]['three_dart_average'] - (float) $rows[$index]['three_dart_average']) < 0.0001) {
                $bucket[] = $rows[$cursor];
                $cursor++;
            }

            if (count($bucket) > 1) {
                $headToHead = $this->headToHeadPoints(
                    $tournamentId,
                    array_map(static fn (array $row): int => (int) $row['player_id'], $bucket),
                    $groupId
                );
                foreach ($bucket as &$row) {
                    $row['head_to_head_points'] = (int) ($headToHead[(int) $row['player_id']] ?? 0);
                }
                unset($row);
                usort($bucket, static function (array $a, array $b): int {
                    $cmp = ((int) $b['head_to_head_points']) <=> ((int) $a['head_to_head_points']);
                    return $cmp !== 0 ? $cmp : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
                });
            }

            array_push($ranked, ...$bucket);
            $index = $cursor;
        }

        foreach ($ranked as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);
        return $ranked;
    }

    /** @param list<int> $playerIds @return array<int,int> */
    private function headToHeadPoints(int $tournamentId, array $playerIds, ?int $groupId): array
    {
        $playerIds = array_values(array_unique(array_filter(array_map('intval', $playerIds), static fn (int $id): bool => $id > 0)));
        if (count($playerIds) < 2) return [];
        $ids = implode(',', $playerIds);
        $groupFilter = $groupId !== null ? ' AND m.tournament_group_id=' . (int) $groupId : '';
        $sql = sprintf(
            'SELECT m.player_a_id,m.player_b_id,m.winner_player_id
             FROM `%1$smatches` m
             WHERE m.tournament_id=%2$d AND m.status="completed"%3$s
               AND m.player_a_id IN (%4$s) AND m.player_b_id IN (%4$s)',
            $this->tablePrefix,
            $tournamentId,
            $groupFilter,
            $ids
        );
        $rows = $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
        $points = array_fill_keys($playerIds, 0);
        foreach ($rows as $row) {
            $a = (int) $row['player_a_id'];
            $b = (int) $row['player_b_id'];
            if ($row['winner_player_id'] === null) {
                $points[$a] = ($points[$a] ?? 0) + 1;
                $points[$b] = ($points[$b] ?? 0) + 1;
            } else {
                $winner = (int) $row['winner_player_id'];
                $points[$winner] = ($points[$winner] ?? 0) + 2;
            }
        }
        return $points;
    }

    /** @return array<int, array<string, mixed>> */
    private function listRecentMatchesForAliases(array $playerIds, int $limit): array
    {
        $playerIds = array_values(array_unique(array_map('intval', $playerIds)));
        $ids = implode(',', $playerIds);
        $limit = max(1, min(250, $limit));
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, t.name AS tournament_name, t.start_at,
                    m.round_label, m.bracket_label, m.status, m.winner_player_id, m.finished_at,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    (SELECT ms.average FROM `%1$smatch_statistics` ms WHERE ms.match_id=m.id AND ms.player_id IN (%2$s) ORDER BY ms.id ASC LIMIT 1) AS average,
                    (SELECT ms.highest_checkout FROM `%1$smatch_statistics` ms WHERE ms.match_id=m.id AND ms.player_id IN (%2$s) ORDER BY ms.id ASC LIMIT 1) AS highest_checkout,
                    (SELECT ms.score_180 FROM `%1$smatch_statistics` ms WHERE ms.match_id=m.id AND ms.player_id IN (%2$s) ORDER BY ms.id ASC LIMIT 1) AS score_180
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             WHERE (m.player_a_id IN (%2$s) OR m.player_b_id IN (%2$s)) AND m.status="completed"
             ORDER BY COALESCE(m.finished_at, t.start_at, m.created_at) DESC, m.id DESC
             LIMIT %3$d',
            $this->tablePrefix,
            $ids,
            $limit
        );
        $rows = $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
        $lookup = array_fill_keys($playerIds, true);
        foreach ($rows as &$row) {
            $a = (int) $row['player_a_id'];
            $b = (int) $row['player_b_id'];
            $row['opponent_name'] = isset($lookup[$a]) ? $row['player_b_name'] : $row['player_a_name'];
            $row['result'] = $row['winner_player_id'] === null
                ? 'draw'
                : (isset($lookup[(int) $row['winner_player_id']]) ? 'win' : 'loss');
            $row['average'] = $row['average'] !== null ? (float) $row['average'] : null;
        }
        unset($row);
        return $rows;
    }

    /** @return array<int, array<string, mixed>> */
    private function listEloHistoryForAliases(array $playerIds, int $limit): array
    {
        $ids = implode(',', array_map('intval', $playerIds));
        $limit = max(1, min(100, $limit));
        $sql = sprintf(
            'SELECT rs.id, rs.points AS rating, rs.position, rs.scope_type, rs.tournament_id,
                    t.name AS tournament_name, rs.calculated_at
             FROM `%1$sranking_snapshots` rs
             LEFT JOIN `%1$stournaments` t ON t.id=rs.tournament_id
             WHERE rs.player_id IN (%2$s) AND rs.ranking_type="elo"
             ORDER BY rs.calculated_at DESC, rs.id DESC
             LIMIT %3$d',
            $this->tablePrefix,
            $ids,
            $limit
        );
        return $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
    }

    /** @return array{rating:float,source:string,calculated_at:?string,baseline_played:?int} */
    private function getEloForAliases(array $playerIds, string $displayName): array
    {
        $ids = implode(',', array_map('intval', $playerIds));
        $sql = sprintf(
            'SELECT points, calculated_at FROM `%1$sranking_snapshots`
             WHERE player_id IN (%2$s) AND ranking_type="elo"
             ORDER BY calculated_at DESC, id DESC LIMIT 1',
            $this->tablePrefix,
            $ids
        );
        $row = $this->connection->query($sql)->fetch_assoc() ?: null;
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

    /** @return array<string,mixed>|null */
    private function basicPlayer(int $playerId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,club_id,member_id,display_name,nickname,avatar_url,is_active FROM `%1$splayers` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string,mixed> $player @return list<int> */
    private function playerAliasIds(array $player): array
    {
        $clubId = (int) ($player['club_id'] ?? 0);
        $name = trim((string) ($player['display_name'] ?? ''));
        $memberId = $player['member_id'] !== null ? (int) $player['member_id'] : null;
        if ($clubId <= 0 || $name === '') return [(int) $player['id']];

        $sql = sprintf(
            'SELECT id,member_id FROM `%1$splayers`
             WHERE club_id=? AND is_active=1 AND LOWER(TRIM(display_name))=LOWER(TRIM(?))
             ORDER BY id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('is', $clubId, $name);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $ids = [];
        foreach ($rows as $row) {
            $rowMemberId = $row['member_id'] !== null ? (int) $row['member_id'] : null;
            if ($memberId !== null) {
                if ($rowMemberId !== null && $rowMemberId !== $memberId) continue;
            } elseif ($rowMemberId !== null) {
                continue;
            }
            $ids[] = (int) $row['id'];
        }
        if (!in_array((int) $player['id'], $ids, true)) $ids[] = (int) $player['id'];
        sort($ids);
        return array_values(array_unique($ids));
    }

    /** @param array<int,array<string,mixed>> $rows @return array<int,array<string,mixed>> */
    private function collapseDuplicatePlayerRows(array $rows): array
    {
        $groups = [];
        foreach ($rows as $row) {
            $key = mb_strtolower(trim((string) ($row['display_name'] ?? '')), 'UTF-8');
            $groups[$key][] = $row;
        }

        $result = [];
        foreach ($groups as $group) {
            if (count($group) === 1) {
                $result[] = $group[0];
                continue;
            }

            $memberIds = array_values(array_unique(array_filter(array_map(
                static fn (array $row): int => (int) ($row['member_id'] ?? 0),
                $group
            ))));
            if (count($memberIds) > 1) {
                array_push($result, ...$group);
                continue;
            }

            usort($group, static function (array $a, array $b): int {
                $member = ((int) ($b['member_id'] ?? 0) > 0 ? 1 : 0) <=> ((int) ($a['member_id'] ?? 0) > 0 ? 1 : 0);
                if ($member !== 0) return $member;
                $matches = ((int) ($b['matches_played'] ?? 0)) <=> ((int) ($a['matches_played'] ?? 0));
                return $matches !== 0 ? $matches : ((int) $a['id']) <=> ((int) $b['id']);
            });
            $merged = $group[0];
            $merged['duplicate_player_ids'] = array_map(static fn (array $row): int => (int) $row['id'], $group);
            $merged['matches_played'] = array_sum(array_map(static fn (array $row): int => (int) ($row['matches_played'] ?? 0), $group));
            $merged['matches_won'] = array_sum(array_map(static fn (array $row): int => (int) ($row['matches_won'] ?? 0), $group));
            $merged['matches_lost'] = max(0, $merged['matches_played'] - $merged['matches_won']);
            $merged['win_percentage'] = $merged['matches_played'] > 0 ? round(($merged['matches_won'] / $merged['matches_played']) * 100, 1) : 0.0;
            $merged['score_180'] = array_sum(array_map(static fn (array $row): int => (int) ($row['score_180'] ?? 0), $group));
            $merged['highest_checkout'] = max(array_map(static fn (array $row): int => (int) ($row['highest_checkout'] ?? 0), $group));
            $merged['recorded_darts'] = array_sum(array_map(static fn (array $row): int => (int) ($row['recorded_darts'] ?? 0), $group));
            if ($merged['recorded_darts'] > 0) {
                $weighted = 0.0;
                foreach ($group as $row) {
                    $weighted += (float) ($row['recorded_average'] ?? 0) * (int) ($row['recorded_darts'] ?? 0);
                }
                $merged['recorded_average'] = round($weighted / $merged['recorded_darts'], 2);
                $merged['three_dart_average'] = $merged['recorded_average'];
            } else {
                $averages = array_values(array_filter(array_map(static fn (array $row): float => (float) ($row['recorded_average'] ?? 0), $group), static fn (float $v): bool => $v > 0));
                $merged['recorded_average'] = $averages !== [] ? round(array_sum($averages) / count($averages), 2) : 0.0;
                $merged['three_dart_average'] = $merged['recorded_average'];
            }
            $merged['baseline_played'] = max(array_map(static fn (array $row): int => (int) ($row['baseline_played'] ?? 0), $group));

            $snapshotRows = array_values(array_filter($group, static fn (array $row): bool => ($row['elo_source'] ?? '') === 'ranking_snapshot'));
            if ($snapshotRows !== []) {
                usort($snapshotRows, static fn (array $a, array $b): int => strcmp((string) ($b['elo_calculated_at'] ?? ''), (string) ($a['elo_calculated_at'] ?? '')));
                $merged['elo_rating'] = (float) $snapshotRows[0]['elo_rating'];
                $merged['elo_source'] = 'ranking_snapshot';
                $merged['elo_calculated_at'] = $snapshotRows[0]['elo_calculated_at'];
            }
            $result[] = $merged;
        }

        usort($result, static fn (array $a, array $b): int => strcasecmp((string) $a['display_name'], (string) $b['display_name']));
        return $result;
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
