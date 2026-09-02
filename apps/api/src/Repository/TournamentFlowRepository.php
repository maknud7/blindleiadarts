<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class TournamentFlowRepository
{
    private const MIN_PLAYERS = 2;

    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed>|null */
    public function findTournament(int $tournamentId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, club_id, name, status, start_at, registration_opens_at, registration_closes_at
             FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed> */
    public function startTournament(int $tournamentId): array
    {
        $tournament = $this->findTournament($tournamentId);
        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }

        $status = (string) ($tournament['status'] ?? '');
        if (in_array($status, ['completed', 'archived'], true)) {
            throw new ValidationException('tournament_already_closed', 'Turneringen er allerede avsluttet.');
        }

        $matchCount = $this->countMatches($tournamentId);
        if ($matchCount > 0 && $status !== 'in_progress') {
            throw new ValidationException('tournament_has_matches', 'Turneringen har allerede kamper og kan ikke startes på nytt.');
        }

        $checkedIn = $this->countRegistrations($tournamentId, ['checked_in']);
        if ($checkedIn < self::MIN_PLAYERS) {
            throw new ValidationException('not_enough_checked_in_players', 'Minst to spillere må delta før turneringen kan startes.');
        }

        if ($status === 'in_progress') {
            $this->captureEloStartSnapshot($tournamentId);
            return [
                'tournament_id' => $tournamentId,
                'status' => 'in_progress',
                'checked_in_count' => $checkedIn,
                'no_show_count' => $this->countRegistrations($tournamentId, ['no_show']),
                'withdrawn_waitlist_count' => 0,
                'already_started' => true,
            ];
        }

        $registered = $this->countRegistrations($tournamentId, ['registered', 'paused']);
        $waitlisted = $this->countRegistrations($tournamentId, ['waitlisted']);

        $this->connection->begin_transaction();
        try {
            $deleteGroupPlayers = $this->connection->prepare(sprintf(
                'DELETE gp FROM `%1$stournament_group_players` gp
                 INNER JOIN `%1$stournament_groups` g ON g.id=gp.group_id
                 WHERE g.tournament_id=?',
                $this->tablePrefix
            ));
            $deleteGroupPlayers->bind_param('i', $tournamentId);
            $deleteGroupPlayers->execute();
            $deleteGroupPlayers->close();

            $deleteGroups = $this->connection->prepare(sprintf(
                'DELETE FROM `%1$stournament_groups` WHERE tournament_id=?',
                $this->tablePrefix
            ));
            $deleteGroups->bind_param('i', $tournamentId);
            $deleteGroups->execute();
            $deleteGroups->close();

            $noShows = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_players`
                 SET status="no_show", seed=NULL, seed_rating=NULL, seed_rating_source=NULL
                 WHERE tournament_id=? AND status IN ("registered","paused")',
                $this->tablePrefix
            ));
            $noShows->bind_param('i', $tournamentId);
            $noShows->execute();
            $noShows->close();

            $waitlist = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_players`
                 SET status="withdrawn", seed=NULL, seed_rating=NULL, seed_rating_source=NULL
                 WHERE tournament_id=? AND status="waitlisted"',
                $this->tablePrefix
            ));
            $waitlist->bind_param('i', $tournamentId);
            $waitlist->execute();
            $waitlist->close();

            $clearSeeds = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_players`
                 SET seed=NULL, seed_rating=NULL, seed_rating_source=NULL
                 WHERE tournament_id=?',
                $this->tablePrefix
            ));
            $clearSeeds->bind_param('i', $tournamentId);
            $clearSeeds->execute();
            $clearSeeds->close();

            $start = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments`
                 SET status="in_progress",
                     registration_closes_at=COALESCE(registration_closes_at, NOW()),
                     group_count=NULL, group_draw_mode=NULL, group_draw_seed=NULL, group_drawn_at=NULL
                 WHERE id=?',
                $this->tablePrefix
            ));
            $start->bind_param('i', $tournamentId);
            $start->execute();
            $start->close();

            // Freeze each checked-in player's ELO at the tournament boundary.
            // INSERT IGNORE makes start idempotent and guarantees the entry value
            // can never drift when live ELO changes later in the tournament.
            $this->captureEloStartSnapshot($tournamentId);

            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return [
            'tournament_id' => $tournamentId,
            'status' => 'in_progress',
            'checked_in_count' => $checkedIn,
            'no_show_count' => $registered,
            'withdrawn_waitlist_count' => $waitlisted,
            'already_started' => false,
        ];
    }

    private function captureEloStartSnapshot(int $tournamentId): void
    {
        $sql = sprintf(
            'INSERT IGNORE INTO `%1$stournament_elo_snapshots`
             (tournament_id,season_id,club_id,player_id,elo_before,matches_before,captured_start_at)
             SELECT t.id,t.season_id,t.club_id,tp.player_id,
                    COALESCE(ecr.rating,1000),COALESCE(ecr.matches_played,0),COALESCE(t.start_at,NOW())
             FROM `%1$stournaments` t
             INNER JOIN `%1$stournament_players` tp ON tp.tournament_id=t.id
             LEFT JOIN `%1$selo_current_ratings` ecr ON ecr.season_id=t.season_id AND ecr.player_id=tp.player_id
             WHERE t.id=? AND t.elo_enabled=1 AND t.season_id IS NOT NULL
               AND tp.status="checked_in"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<int,string> $statuses */
    private function countRegistrations(int $tournamentId, array $statuses): int
    {
        if ($statuses === []) return 0;
        $quoted = implode(',', array_map(static fn (string $status): string => '"' . $status . '"', $statuses));
        $stmt = $this->connection->prepare(sprintf(
            'SELECT COUNT(*) AS cnt FROM `%1$stournament_players` WHERE tournament_id=? AND status IN (%2$s)',
            $this->tablePrefix,
            $quoted
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $count = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
        $stmt->close();
        return $count;
    }

    private function countMatches(int $tournamentId): int
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT COUNT(*) AS cnt FROM `%1$smatches` WHERE tournament_id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $count = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
        $stmt->close();
        return $count;
    }
}
