<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class EloReadRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    /** @var array<string,array{rating:float,played:int}> */
    private array $baseline = [];

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->loadBaseline();
    }

    /** @return array<int,array<string,mixed>> */
    public function listClubElo(int $clubId): array
    {
        $seasonId = $this->resolveSeasonId($clubId);
        $sql = sprintf(
            'SELECT p.id, p.display_name, p.nickname, p.avatar_url,
                    ecr.rating AS elo_rating, ecr.matches_played AS elo_matches_played, ecr.updated_at AS elo_calculated_at,
                    COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS local_matches_played,
                    COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS matches_won
             FROM `%1$splayers` p
             LEFT JOIN `%1$selo_current_ratings` ecr ON ecr.player_id=p.id AND ecr.season_id=?
             LEFT JOIN `%1$smatches` m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
             WHERE p.club_id=? AND p.is_active=1
             GROUP BY p.id, p.display_name, p.nickname, p.avatar_url,
                      ecr.rating, ecr.matches_played, ecr.updated_at
             ORDER BY p.display_name ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $seasonId, $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            if ($row['elo_rating'] !== null) {
                $row['elo_rating'] = (float) $row['elo_rating'];
                $row['elo_matches_played'] = (int) $row['elo_matches_played'];
                $row['elo_source'] = 'elo_ledger';
            } else {
                $key = mb_strtolower(trim((string) $row['display_name']), 'UTF-8');
                if (isset($this->baseline[$key])) {
                    $row['elo_rating'] = $this->baseline[$key]['rating'];
                    $row['elo_matches_played'] = $this->baseline[$key]['played'];
                    $row['elo_source'] = 'mandagsserien_2026_08_24';
                } else {
                    $row['elo_rating'] = 1000.0;
                    $row['elo_matches_played'] = 0;
                    $row['elo_source'] = 'default_1000';
                }
            }
            $row['local_matches_played'] = (int) ($row['local_matches_played'] ?? 0);
            $row['matches_won'] = (int) ($row['matches_won'] ?? 0);
            $row['season_id'] = $seasonId;
        }
        unset($row);

        usort($rows, static function (array $a, array $b): int {
            $rating = ((float) $b['elo_rating']) <=> ((float) $a['elo_rating']);
            return $rating !== 0 ? $rating : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });
        foreach ($rows as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);
        return $rows;
    }

    /** @return array<string,mixed>|null */
    public function getTournamentEloSetting(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT id, club_id, season_id, name, elo_enabled
             FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            $row['elo_enabled'] = (int) $row['elo_enabled'] === 1;
        }
        return $row;
    }

    /** @return array<string,mixed> */
    public function updateTournamentEloSetting(int $tournamentId, bool $enabled): array
    {
        $tournament = $this->getTournamentEloSetting($tournamentId);
        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }
        if ((bool) $tournament['elo_enabled'] === $enabled) {
            return $tournament;
        }

        $sql = sprintf(
            'SELECT COUNT(*) AS c FROM `%1$smatches` WHERE tournament_id=? AND status="completed"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $completed = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0);
        $stmt->close();
        if ($completed > 0) {
            throw new ValidationException(
                'elo_setting_locked',
                'ELO-innstillingen kan ikke endres etter at turneringen har fullførte kamper.',
                409
            );
        }

        $value = $enabled ? 1 : 0;
        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments` SET elo_enabled=? WHERE id=?',
            $this->tablePrefix
        ));
        $update->bind_param('ii', $value, $tournamentId);
        $update->execute();
        $update->close();
        return $this->getTournamentEloSetting($tournamentId) ?? [];
    }

    private function resolveSeasonId(int $clubId): int
    {
        $sql = sprintf(
            'SELECT id FROM `%1$sseasons`
             WHERE club_id=?
             ORDER BY is_active DESC, COALESCE(starts_on,"0000-01-01") DESC, id DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $seasonId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();
        return $seasonId;
    }

    private function loadBaseline(): void
    {
        $path = dirname(__DIR__, 2) . '/data/mandagsserien-elo-2026-08-24.php';
        if (!is_file($path)) {
            return;
        }
        $data = require $path;
        foreach ((array) ($data['players'] ?? []) as $player) {
            $key = mb_strtolower(trim((string) ($player['display_name'] ?? '')), 'UTF-8');
            if ($key === '') {
                continue;
            }
            $this->baseline[$key] = [
                'rating' => (float) ($player['rating'] ?? 1000.0),
                'played' => (int) ($player['played'] ?? 0),
            ];
        }
    }
}
