<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Service\SingleEliminationService;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class TournamentPlayoffRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private SingleEliminationService $bracket;
    private PlayerPortalRepository $portal;

    public function __construct(
        Database $database,
        ?SingleEliminationService $bracket = null,
        ?PlayerPortalRepository $portal = null
    ) {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->bracket = $bracket ?? new SingleEliminationService();
        $this->portal = $portal ?? new PlayerPortalRepository($database);
    }

    /** @return array<string,mixed>|null */
    public function findByTournamentId(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT po.id, po.tournament_id, po.format, po.qualifiers_per_group, po.bracket_size,
                    po.best_of_legs, po.status, po.champion_player_id, champion.display_name AS champion_name,
                    po.created_at, po.updated_at, t.club_id, t.name AS tournament_name, t.status AS tournament_status
             FROM `%1$stournament_playoffs` po
             INNER JOIN `%1$stournaments` t ON t.id=po.tournament_id
             LEFT JOIN `%1$splayers` champion ON champion.id=po.champion_player_id
             WHERE po.tournament_id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            foreach (['id', 'tournament_id', 'qualifiers_per_group', 'bracket_size', 'best_of_legs', 'club_id'] as $field) {
                $row[$field] = (int) $row[$field];
            }
            $row['champion_player_id'] = $row['champion_player_id'] !== null ? (int) $row['champion_player_id'] : null;
        }
        return $row;
    }

    /** @return array<string,mixed> */
    public function generateFromGroups(int $tournamentId, int $qualifiersPerGroup, int $bestOfLegs): array
    {
        if ($qualifiersPerGroup < 1 || $qualifiersPerGroup > 16) {
            throw new ValidationException('invalid_qualifiers_per_group', 'Antall videre per gruppe må være mellom 1 og 16.');
        }
        if ($bestOfLegs < 1 || $bestOfLegs > 21 || $bestOfLegs % 2 === 0) {
            throw new ValidationException('invalid_best_of_legs', 'Best of legs må være et oddetall mellom 1 og 21.');
        }
        $tournament = $this->requireTournament($tournamentId);
        if ($this->findByTournamentId($tournamentId) !== null) {
            throw new ValidationException('playoff_already_exists', 'Sluttspillet er allerede opprettet for denne turneringen.', 409);
        }

        $groupCounts = $this->groupMatchCounts($tournamentId);
        if ($groupCounts['total'] < 1) {
            throw new ValidationException('group_matches_required', 'Gruppespill må være generert før sluttspill kan opprettes.', 409);
        }
        if ($groupCounts['open'] > 0) {
            throw new ValidationException('group_stage_not_completed', 'Alle gruppekamper må være ferdige før sluttspillet kan opprettes.', 409);
        }

        $tables = $this->portal->getTournamentTables($tournamentId);
        $groups = array_values(array_filter(
            (array) ($tables['groups'] ?? []),
            static fn (array $group): bool => $group['id'] !== null
        ));
        if ($groups === []) {
            throw new ValidationException('group_tables_required', 'Fant ingen gruppetabeller for turneringen.', 409);
        }

        $qualifiers = [];
        foreach ($groups as $group) {
            $rows = array_values((array) ($group['rows'] ?? []));
            if (count($rows) < $qualifiersPerGroup) {
                throw new ValidationException(
                    'not_enough_players_in_group',
                    sprintf('%s har bare %d spillere og kan ikke sende %d videre.', (string) $group['name'], count($rows), $qualifiersPerGroup),
                    409
                );
            }
            for ($index = 0; $index < $qualifiersPerGroup; $index++) {
                $row = $rows[$index];
                $qualifiers[] = [
                    'player_id' => (int) $row['player_id'],
                    'display_name' => (string) $row['display_name'],
                    'seed_number' => $row['seed_number'] !== null ? (int) $row['seed_number'] : null,
                    'source_group_id' => (int) $group['id'],
                    'source_group_name' => (string) $group['name'],
                    'source_group_position' => $index + 1,
                    'points' => (int) ($row['points'] ?? 0),
                    'leg_diff' => (int) ($row['leg_diff'] ?? 0),
                    'legs_won' => (int) ($row['legs_won'] ?? 0),
                ];
            }
        }

        $qualifiers = $this->bracket->seedQualifiers($qualifiers);
        $bracketSize = $this->bracket->bracketSize(count($qualifiers));
        $roundCount = $this->bracket->roundCount($bracketSize);

        $this->connection->begin_transaction();
        try {
            $playoffId = $this->insertPlayoff($tournamentId, $qualifiersPerGroup, $bracketSize, $bestOfLegs);
            foreach ($qualifiers as $qualifier) {
                $this->insertEntry($playoffId, $qualifier);
            }
            $this->insertNodes($playoffId, $bracketSize, $roundCount);
            $this->seedFirstRound($playoffId, $bracketSize, $qualifiers);
            $this->materializeFirstRound($playoffId, $tournamentId, $bestOfLegs, $bracketSize);
            $this->propagateResolvedNodes($playoffId, $tournamentId, $bestOfLegs, $bracketSize);
            $this->markNonQualifiersEliminated($tournamentId, array_column($qualifiers, 'player_id'));

            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments` SET status="in_progress", end_at=NULL WHERE id=?',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $stmt->close();

            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $this->getBracket($tournamentId) ?? [
            'tournament' => $tournament,
            'playoff' => null,
            'entries' => [],
            'rounds' => [],
        ];
    }

    /** @return array<string,mixed>|null */
    public function getBracket(int $tournamentId): ?array
    {
        $playoff = $this->findByTournamentId($tournamentId);
        if ($playoff === null) {
            return null;
        }
        $playoffId = (int) $playoff['id'];

        $entrySql = sprintf(
            'SELECT e.player_id, p.display_name, p.nickname, e.seed_number,
                    e.source_group_id, g.name AS source_group_name, e.source_group_position,
                    e.source_points AS points, e.source_leg_diff AS leg_diff, e.source_legs_won AS legs_won
             FROM `%1$stournament_playoff_entries` e
             INNER JOIN `%1$splayers` p ON p.id=e.player_id
             INNER JOIN `%1$stournament_groups` g ON g.id=e.source_group_id
             WHERE e.playoff_id=? ORDER BY e.seed_number ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($entrySql);
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $entries = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($entries as &$entry) {
            foreach (['player_id', 'seed_number', 'source_group_id', 'source_group_position', 'points', 'leg_diff', 'legs_won'] as $field) {
                $entry[$field] = (int) $entry[$field];
            }
        }
        unset($entry);

        $nodeSql = sprintf(
            'SELECT n.id, n.round_number, n.position, n.round_label, n.status AS node_status,
                    n.player_a_id, pa.display_name AS player_a_name,
                    n.player_b_id, pb.display_name AS player_b_name,
                    n.match_id, m.status AS match_status, m.kiosk_id, k.board_number,
                    n.winner_player_id, winner.display_name AS winner_name
             FROM `%1$stournament_playoff_nodes` n
             LEFT JOIN `%1$splayers` pa ON pa.id=n.player_a_id
             LEFT JOIN `%1$splayers` pb ON pb.id=n.player_b_id
             LEFT JOIN `%1$smatches` m ON m.id=n.match_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
             LEFT JOIN `%1$splayers` winner ON winner.id=n.winner_player_id
             WHERE n.playoff_id=?
             ORDER BY n.round_number ASC, n.position ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($nodeSql);
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $nodes = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $rounds = [];
        foreach ($nodes as $node) {
            $round = (int) $node['round_number'];
            if (!isset($rounds[$round])) {
                $rounds[$round] = [
                    'round_number' => $round,
                    'label' => (string) $node['round_label'],
                    'nodes' => [],
                ];
            }
            foreach (['id', 'round_number', 'position'] as $field) {
                $node[$field] = (int) $node[$field];
            }
            foreach (['player_a_id', 'player_b_id', 'match_id', 'kiosk_id', 'board_number', 'winner_player_id'] as $field) {
                $node[$field] = $node[$field] !== null ? (int) $node[$field] : null;
            }
            $node['status'] = $node['match_status'] ?: $node['node_status'];
            unset($node['match_status'], $node['node_status']);
            $rounds[$round]['nodes'][] = $node;
        }

        return [
            'tournament' => [
                'id' => $tournamentId,
                'club_id' => (int) $playoff['club_id'],
                'name' => $playoff['tournament_name'],
                'status' => $playoff['tournament_status'],
            ],
            'playoff' => $playoff,
            'entries' => $entries,
            'rounds' => array_values($rounds),
        ];
    }

    /** @return array<string,mixed>|null */
    public function reconcileTournament(int $tournamentId): ?array
    {
        $this->connection->begin_transaction();
        try {
            $playoff = $this->lockPlayoff($tournamentId);
            if ($playoff === null) {
                $this->connection->commit();
                return null;
            }
            $playoffId = (int) $playoff['id'];
            $bestOfLegs = (int) $playoff['best_of_legs'];
            $bracketSize = (int) $playoff['bracket_size'];

            $this->syncCompletedMatches($playoffId);
            $this->propagateResolvedNodes($playoffId, $tournamentId, $bestOfLegs, $bracketSize);
            $this->markPlayoffLosersEliminated($playoffId, $tournamentId);
            $this->updatePlayoffLifecycle($playoffId, $tournamentId);
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
        return $this->getBracket($tournamentId);
    }

    public function reconcileByMatchId(int $matchId): void
    {
        $sql = sprintf(
            'SELECT po.tournament_id
             FROM `%1$stournament_playoff_nodes` n
             INNER JOIN `%1$stournament_playoffs` po ON po.id=n.playoff_id
             WHERE n.match_id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            $this->reconcileTournament((int) $row['tournament_id']);
        }
    }

    public function assertUndoAllowedForMatch(int $matchId): void
    {
        $node = $this->nodeByMatchId($matchId);
        if ($node === null) {
            return;
        }
        $parent = $this->parentNode((int) $node['playoff_id'], (int) $node['round_number'], (int) $node['position']);
        if ($parent === null || $parent['match_id'] === null) {
            return;
        }
        $status = (string) ($parent['match_status'] ?? '');
        if ($status === 'pending' && $parent['kiosk_id'] === null) {
            return;
        }
        throw new ValidationException(
            'playoff_downstream_started',
            'Resultatet kan ikke angres fordi neste sluttspillkamp allerede er kalt opp eller startet.',
            409
        );
    }

    public function rewindAfterUndo(int $matchId): void
    {
        $this->connection->begin_transaction();
        try {
            $node = $this->nodeByMatchId($matchId, true);
            if ($node === null) {
                $this->connection->commit();
                return;
            }
            $playoffId = (int) $node['playoff_id'];
            $tournamentId = (int) $node['tournament_id'];
            $this->invalidateAncestors($playoffId, (int) $node['round_number'], (int) $node['position']);

            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_playoff_nodes`
                 SET winner_player_id=NULL, status=CASE WHEN match_id IS NULL THEN "waiting" ELSE "ready" END
                 WHERE id=?',
                $this->tablePrefix
            ));
            $nodeId = (int) $node['id'];
            $stmt->bind_param('i', $nodeId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_playoffs` SET status="in_progress", champion_player_id=NULL WHERE id=?',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $playoffId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments` SET status="in_progress", end_at=NULL WHERE id=?',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $stmt->close();
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /** @return array<string,mixed>|null */
    public function latestPlayoffMatchForKiosk(int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.status, m.finished_at
             FROM `%1$smatches` m
             INNER JOIN `%1$stournament_playoff_nodes` n ON n.match_id=m.id
             WHERE m.kiosk_id=?
             ORDER BY CASE WHEN m.status="completed" THEN 0 ELSE 1 END,
                      COALESCE(m.finished_at,m.starts_at,m.created_at) DESC, m.id DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed> */
    private function requireTournament(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, club_id, name, status FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen finnes ikke.', 404);
        }
        return $row;
    }

    /** @return array{total:int,open:int} */
    private function groupMatchCounts(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status<>"completed" THEN 1 ELSE 0 END) AS open_count
             FROM `%1$smatches` WHERE tournament_id=? AND tournament_group_id IS NOT NULL',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return ['total' => (int) ($row['total'] ?? 0), 'open' => (int) ($row['open_count'] ?? 0)];
    }

    private function insertPlayoff(int $tournamentId, int $qualifiersPerGroup, int $bracketSize, int $bestOfLegs): int
    {
        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$stournament_playoffs`
             (tournament_id, qualifiers_per_group, bracket_size, best_of_legs, status)
             VALUES (?, ?, ?, ?, "ready")',
            $this->tablePrefix
        ));
        $stmt->bind_param('iiii', $tournamentId, $qualifiersPerGroup, $bracketSize, $bestOfLegs);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return $id;
    }

    /** @param array<string,mixed> $qualifier */
    private function insertEntry(int $playoffId, array $qualifier): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$stournament_playoff_entries`
             (playoff_id, player_id, seed_number, source_group_id, source_group_position,
              source_points, source_leg_diff, source_legs_won)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        ));
        $playerId = (int) $qualifier['player_id'];
        $seed = (int) $qualifier['playoff_seed'];
        $groupId = (int) $qualifier['source_group_id'];
        $groupPosition = (int) $qualifier['source_group_position'];
        $points = (int) $qualifier['points'];
        $legDiff = (int) $qualifier['leg_diff'];
        $legsWon = (int) $qualifier['legs_won'];
        $stmt->bind_param('iiiiiiii', $playoffId, $playerId, $seed, $groupId, $groupPosition, $points, $legDiff, $legsWon);
        $stmt->execute();
        $stmt->close();
    }

    private function insertNodes(int $playoffId, int $bracketSize, int $roundCount): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$stournament_playoff_nodes`
             (playoff_id, round_number, position, round_label, status)
             VALUES (?, ?, ?, ?, "waiting")',
            $this->tablePrefix
        ));
        for ($round = 1; $round <= $roundCount; $round++) {
            $matchesInRound = intdiv($bracketSize, 2 ** $round);
            $label = $this->bracket->roundLabel($bracketSize, $round);
            for ($position = 1; $position <= $matchesInRound; $position++) {
                $stmt->bind_param('iiis', $playoffId, $round, $position, $label);
                $stmt->execute();
            }
        }
        $stmt->close();
    }

    /** @param array<int,array<string,mixed>> $qualifiers */
    private function seedFirstRound(int $playoffId, int $bracketSize, array $qualifiers): void
    {
        $bySeed = [];
        foreach ($qualifiers as $qualifier) {
            $bySeed[(int) $qualifier['playoff_seed']] = (int) $qualifier['player_id'];
        }
        $order = $this->bracket->seedOrder($bracketSize);
        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_playoff_nodes`
             SET player_a_id=?, player_b_id=?
             WHERE playoff_id=? AND round_number=1 AND position=?',
            $this->tablePrefix
        ));
        $pairs = intdiv($bracketSize, 2);
        for ($position = 1; $position <= $pairs; $position++) {
            $seedA = $order[($position - 1) * 2];
            $seedB = $order[(($position - 1) * 2) + 1];
            $a = $bySeed[$seedA] ?? null;
            $b = $bySeed[$seedB] ?? null;
            $update->bind_param('iiii', $a, $b, $playoffId, $position);
            $update->execute();
        }
        $update->close();
    }

    private function materializeFirstRound(int $playoffId, int $tournamentId, int $bestOfLegs, int $bracketSize): void
    {
        foreach ($this->nodesForRound($playoffId, 1) as $node) {
            $a = $node['player_a_id'] !== null ? (int) $node['player_a_id'] : null;
            $b = $node['player_b_id'] !== null ? (int) $node['player_b_id'] : null;
            if ($a !== null && $b !== null) {
                $matchId = $this->createPlayoffMatch($tournamentId, $bestOfLegs, $bracketSize, 1, (int) $node['position'], $a, $b);
                $this->setNodeMatch((int) $node['id'], $matchId);
            } elseif ($a !== null || $b !== null) {
                $winner = $a ?? $b;
                $this->setNodeBye((int) $node['id'], (int) $winner);
            }
        }
    }

    private function propagateResolvedNodes(int $playoffId, int $tournamentId, int $bestOfLegs, int $bracketSize): void
    {
        $roundCount = $this->bracket->roundCount($bracketSize);
        for ($round = 2; $round <= $roundCount; $round++) {
            foreach ($this->nodesForRound($playoffId, $round) as $node) {
                $position = (int) $node['position'];
                $left = $this->nodeByPosition($playoffId, $round - 1, (($position - 1) * 2) + 1);
                $right = $this->nodeByPosition($playoffId, $round - 1, (($position - 1) * 2) + 2);
                $a = $left !== null && $left['winner_player_id'] !== null ? (int) $left['winner_player_id'] : null;
                $b = $right !== null && $right['winner_player_id'] !== null ? (int) $right['winner_player_id'] : null;

                if ($a === null || $b === null) {
                    continue;
                }
                if ($node['match_id'] !== null) {
                    continue;
                }
                $matchId = $this->createPlayoffMatch($tournamentId, $bestOfLegs, $bracketSize, $round, $position, $a, $b);
                $stmt = $this->connection->prepare(sprintf(
                    'UPDATE `%1$stournament_playoff_nodes`
                     SET player_a_id=?, player_b_id=?, match_id=?, status="ready"
                     WHERE id=?',
                    $this->tablePrefix
                ));
                $nodeId = (int) $node['id'];
                $stmt->bind_param('iiii', $a, $b, $matchId, $nodeId);
                $stmt->execute();
                $stmt->close();
            }
        }
    }

    private function createPlayoffMatch(
        int $tournamentId,
        int $bestOfLegs,
        int $bracketSize,
        int $round,
        int $position,
        int $playerA,
        int $playerB
    ): int {
        $label = $this->bracket->roundLabel($bracketSize, $round);
        $matchesInRound = intdiv($bracketSize, 2 ** $round);
        $roundLabel = $matchesInRound > 1 ? $label . ' ' . $position : $label;
        $bracketLabel = 'Sluttspill';
        $status = 'pending';
        $roundNumber = 100 + $round;
        $legsToWin = intdiv($bestOfLegs, 2) + 1;
        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$smatches`
             (tournament_id, tournament_group_id, round_label, round_number, bracket_label, status,
              best_of_legs, legs_to_win, player_a_id, player_b_id)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        ));
        $stmt->bind_param(
            'isissiiii',
            $tournamentId,
            $roundLabel,
            $roundNumber,
            $bracketLabel,
            $status,
            $bestOfLegs,
            $legsToWin,
            $playerA,
            $playerB
        );
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return $id;
    }

    private function setNodeMatch(int $nodeId, int $matchId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_playoff_nodes` SET match_id=?, status="ready" WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $matchId, $nodeId);
        $stmt->execute();
        $stmt->close();
    }

    private function setNodeBye(int $nodeId, int $winnerPlayerId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_playoff_nodes` SET winner_player_id=?, status="bye" WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $winnerPlayerId, $nodeId);
        $stmt->execute();
        $stmt->close();
    }

    /** @return array<int,array<string,mixed>> */
    private function nodesForRound(int $playoffId, int $round): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT * FROM `%1$stournament_playoff_nodes`
             WHERE playoff_id=? AND round_number=? ORDER BY position ASC',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $playoffId, $round);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<string,mixed>|null */
    private function nodeByPosition(int $playoffId, int $round, int $position): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT * FROM `%1$stournament_playoff_nodes`
             WHERE playoff_id=? AND round_number=? AND position=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('iii', $playoffId, $round, $position);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function syncCompletedMatches(int $playoffId): void
    {
        $sql = sprintf(
            'SELECT n.id, n.round_number, n.position, n.winner_player_id AS node_winner,
                    m.status AS match_status, m.winner_player_id AS match_winner
             FROM `%1$stournament_playoff_nodes` n
             INNER JOIN `%1$smatches` m ON m.id=n.match_id
             WHERE n.playoff_id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as $row) {
            $nodeId = (int) $row['id'];
            if ((string) $row['match_status'] === 'completed' && $row['match_winner'] !== null) {
                $winner = (int) $row['match_winner'];
                $update = $this->connection->prepare(sprintf(
                    'UPDATE `%1$stournament_playoff_nodes` SET winner_player_id=?, status="completed" WHERE id=?',
                    $this->tablePrefix
                ));
                $update->bind_param('ii', $winner, $nodeId);
                $update->execute();
                $update->close();
                continue;
            }
            if ($row['node_winner'] !== null && (string) $row['match_status'] !== 'completed') {
                $this->invalidateAncestors($playoffId, (int) $row['round_number'], (int) $row['position']);
                $update = $this->connection->prepare(sprintf(
                    'UPDATE `%1$stournament_playoff_nodes` SET winner_player_id=NULL, status="ready" WHERE id=?',
                    $this->tablePrefix
                ));
                $update->bind_param('i', $nodeId);
                $update->execute();
                $update->close();
            }
        }
    }

    /** @return array<string,mixed>|null */
    private function lockPlayoff(int $tournamentId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT * FROM `%1$stournament_playoffs` WHERE tournament_id=? FOR UPDATE',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function nodeByMatchId(int $matchId, bool $forUpdate = false): ?array
    {
        $sql = sprintf(
            'SELECT n.*, po.tournament_id
             FROM `%1$stournament_playoff_nodes` n
             INNER JOIN `%1$stournament_playoffs` po ON po.id=n.playoff_id
             WHERE n.match_id=? LIMIT 1 %2$s',
            $this->tablePrefix,
            $forUpdate ? 'FOR UPDATE' : ''
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function parentNode(int $playoffId, int $round, int $position): ?array
    {
        $parentRound = $round + 1;
        $parentPosition = intdiv($position + 1, 2);
        $sql = sprintf(
            'SELECT n.*, m.status AS match_status, m.kiosk_id
             FROM `%1$stournament_playoff_nodes` n
             LEFT JOIN `%1$smatches` m ON m.id=n.match_id
             WHERE n.playoff_id=? AND n.round_number=? AND n.position=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $playoffId, $parentRound, $parentPosition);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function invalidateAncestors(int $playoffId, int $round, int $position): void
    {
        $parent = $this->parentNode($playoffId, $round, $position);
        if ($parent === null) {
            return;
        }
        $matchId = $parent['match_id'] !== null ? (int) $parent['match_id'] : null;
        if ($matchId !== null) {
            $status = (string) ($parent['match_status'] ?? '');
            if ($status !== 'pending' || $parent['kiosk_id'] !== null) {
                throw new ValidationException(
                    'playoff_downstream_started',
                    'Kan ikke rulle tilbake sluttspillet fordi neste kamp allerede er kalt opp eller startet.',
                    409
                );
            }
            $clear = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_playoff_nodes`
                 SET player_a_id=NULL, player_b_id=NULL, match_id=NULL, winner_player_id=NULL, status="waiting"
                 WHERE id=?',
                $this->tablePrefix
            ));
            $parentId = (int) $parent['id'];
            $clear->bind_param('i', $parentId);
            $clear->execute();
            $clear->close();

            $delete = $this->connection->prepare(sprintf('DELETE FROM `%1$smatches` WHERE id=? AND status="pending"', $this->tablePrefix));
            $delete->bind_param('i', $matchId);
            $delete->execute();
            $delete->close();
        } else {
            $clear = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_playoff_nodes`
                 SET player_a_id=NULL, player_b_id=NULL, winner_player_id=NULL, status="waiting"
                 WHERE id=?',
                $this->tablePrefix
            ));
            $parentId = (int) $parent['id'];
            $clear->bind_param('i', $parentId);
            $clear->execute();
            $clear->close();
        }
        $this->invalidateAncestors($playoffId, (int) $parent['round_number'], (int) $parent['position']);
    }

    private function markNonQualifiersEliminated(int $tournamentId, array $qualifiedPlayerIds): void
    {
        if ($qualifiedPlayerIds === []) {
            return;
        }
        $ids = implode(',', array_map('intval', $qualifiedPlayerIds));
        $sql = sprintf(
            'UPDATE `%1$stournament_players`
             SET status="eliminated"
             WHERE tournament_id=? AND player_id NOT IN (%2$s)
               AND status IN ("registered","checked_in","paused")',
            $this->tablePrefix,
            $ids
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $stmt->close();
    }

    private function markPlayoffLosersEliminated(int $playoffId, int $tournamentId): void
    {
        $sql = sprintf(
            'SELECT m.player_a_id, m.player_b_id, m.winner_player_id
             FROM `%1$stournament_playoff_nodes` n
             INNER JOIN `%1$smatches` m ON m.id=n.match_id
             WHERE n.playoff_id=? AND m.status="completed" AND m.winner_player_id IS NOT NULL',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_players` SET status="eliminated" WHERE tournament_id=? AND player_id=?',
            $this->tablePrefix
        ));
        foreach ($rows as $row) {
            $winner = (int) $row['winner_player_id'];
            $a = (int) $row['player_a_id'];
            $b = (int) $row['player_b_id'];
            $loser = $winner === $a ? $b : $a;
            $update->bind_param('ii', $tournamentId, $loser);
            $update->execute();
        }
        $update->close();
    }

    private function updatePlayoffLifecycle(int $playoffId, int $tournamentId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT n.winner_player_id
             FROM `%1$stournament_playoff_nodes` n
             WHERE n.playoff_id=?
             ORDER BY n.round_number DESC, n.position ASC LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $final = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        $champion = $final !== null && $final['winner_player_id'] !== null ? (int) $final['winner_player_id'] : null;

        if ($champion !== null) {
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_playoffs` SET status="completed", champion_player_id=? WHERE id=?',
                $this->tablePrefix
            ));
            $stmt->bind_param('ii', $champion, $playoffId);
            $stmt->execute();
            $stmt->close();
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments` SET status="completed", end_at=COALESCE(end_at,NOW()) WHERE id=?',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $stmt->close();
            return;
        }

        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_playoffs` SET status="in_progress", champion_player_id=NULL WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $stmt->close();
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments` SET status="in_progress", end_at=NULL WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $stmt->close();
    }
}
