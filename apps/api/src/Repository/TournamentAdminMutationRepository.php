<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;
use Throwable;

final class TournamentAdminMutationRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<int,int> */
    public function matchIdsForTournament(int $tournamentId): array
    {
        $statement = $this->connection->prepare(sprintf(
            'SELECT id FROM `%1$smatches` WHERE tournament_id=? ORDER BY id ASC',
            $this->tablePrefix
        ));
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_values(array_map(static fn (array $row): int => (int) $row['id'], $rows));
    }

    /** @return array<int,int> */
    public function openMatchBoardIds(int $tournamentId): array
    {
        $statement = $this->connection->prepare(sprintf(
            'SELECT DISTINCT kiosk_id
             FROM `%1$smatches`
             WHERE tournament_id=?
               AND kiosk_id IS NOT NULL
               AND status IN ("assigned","in_progress")',
            $this->tablePrefix
        ));
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_values(array_filter(array_map(
            static fn (array $row): int => (int) ($row['kiosk_id'] ?? 0),
            $rows
        ), static fn (int $id): bool => $id > 0));
    }

    /**
     * Replace the explicit tournament board set.
     * Reservations owned by this tournament are released when their board is removed.
     *
     * @param array<int,mixed> $rawKioskIds
     * @return array<int,int>
     */
    public function replaceBoardSelection(int $tournamentId, array $rawKioskIds): array
    {
        $tournament = $this->requireTournament($tournamentId);
        if (in_array((string) $tournament['status'], ['completed', 'archived'], true)) {
            throw new ValidationException(
                'tournament_boards_locked',
                'Skiver kan ikke endres etter at turneringen er avsluttet.',
                409
            );
        }

        $kioskIds = array_values(array_unique(array_filter(
            array_map('intval', $rawKioskIds),
            static fn (int $id): bool => $id > 0
        )));
        if ($kioskIds === []) {
            throw new ValidationException(
                'tournament_board_required',
                'Velg minst én aktiv skive til turneringen.',
                422
            );
        }

        $clubBoards = $this->clubBoards((int) $tournament['club_id']);
        $boardsById = [];
        foreach ($clubBoards as $board) {
            $boardsById[(int) $board['id']] = $board;
        }
        foreach ($kioskIds as $kioskId) {
            $board = $boardsById[$kioskId] ?? null;
            if ($board === null || (int) $board['is_active'] !== 1) {
                throw new ValidationException(
                    'invalid_tournament_board',
                    'En valgt skive finnes ikke i klubben eller er deaktivert.',
                    422
                );
            }
        }

        $this->connection->begin_transaction();
        try {
            $current = $this->selectedBoardIds($tournamentId);
            $removed = array_values(array_diff($current, $kioskIds));

            if ($removed !== []) {
                $removedSql = implode(',', array_map('intval', $removed));

                // Serialize against kiosk assignment/reservation work while boards are being removed.
                $lockBoards = $this->connection->query(sprintf(
                    'SELECT id FROM `%1$skiosks` WHERE id IN (%2$s) FOR UPDATE',
                    $this->tablePrefix,
                    $removedSql
                ));
                $lockBoards->free();

                $activeSql = sprintf(
                    'SELECT kiosk_id
                     FROM `%1$smatches`
                     WHERE tournament_id=?
                       AND kiosk_id IN (%2$s)
                       AND status IN ("assigned","in_progress")
                     FOR UPDATE',
                    $this->tablePrefix,
                    $removedSql
                );
                $active = $this->connection->prepare($activeSql);
                $active->bind_param('i', $tournamentId);
                $active->execute();
                $activeRows = $active->get_result()->fetch_all(MYSQLI_ASSOC);
                $active->close();
                $blocked = array_fill_keys(array_map(
                    static fn (array $row): int => (int) $row['kiosk_id'],
                    $activeRows
                ), true);

                foreach ($removed as $kioskId) {
                    if (isset($blocked[$kioskId])) {
                        $number = (int) ($boardsById[$kioskId]['board_number'] ?? 0);
                        throw new ValidationException(
                            'tournament_board_in_use',
                            $number > 0
                                ? "Skive {$number} har en aktiv kamp. Flytt kampen før skiven fjernes."
                                : 'Skiven har en aktiv kamp. Flytt kampen før skiven fjernes.',
                            409
                        );
                    }
                }

                $reservationSql = sprintf(
                    'DELETE FROM `%1$stournament_board_reservations`
                     WHERE tournament_id=? AND kiosk_id IN (%2$s)',
                    $this->tablePrefix,
                    $removedSql
                );
                $reservation = $this->connection->prepare($reservationSql);
                $reservation->bind_param('i', $tournamentId);
                $reservation->execute();
                $reservation->close();

                $selectionSql = sprintf(
                    'DELETE FROM `%1$stournament_kiosks`
                     WHERE tournament_id=? AND kiosk_id IN (%2$s)',
                    $this->tablePrefix,
                    $removedSql
                );
                $selection = $this->connection->prepare($selectionSql);
                $selection->bind_param('i', $tournamentId);
                $selection->execute();
                $selection->close();
            }

            $upsert = $this->connection->prepare(sprintf(
                'INSERT INTO `%1$stournament_kiosks` (tournament_id, kiosk_id, sort_order)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order)',
                $this->tablePrefix
            ));
            foreach ($kioskIds as $index => $kioskId) {
                $sortOrder = $index + 1;
                $upsert->bind_param('iii', $tournamentId, $kioskId, $sortOrder);
                $upsert->execute();
            }
            $upsert->close();

            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $kioskIds;
    }

    /** @return array<string,mixed> */
    public function moveMatch(
        int $tournamentId,
        int $matchId,
        int $targetKioskId,
        bool $confirmInProgress
    ): array {
        if ($targetKioskId <= 0) {
            throw new ValidationException('target_board_required', 'Velg en skive kampen skal flyttes til.', 422);
        }

        $this->connection->begin_transaction();
        try {
            $matchStatement = $this->connection->prepare(sprintf(
                'SELECT m.id, m.tournament_id, m.status, m.kiosk_id,
                        m.player_a_id, m.player_b_id,
                        pa.display_name AS player_a_name, pb.display_name AS player_b_name
                 FROM `%1$smatches` m
                 LEFT JOIN `%1$splayers` pa ON pa.id=m.player_a_id
                 LEFT JOIN `%1$splayers` pb ON pb.id=m.player_b_id
                 WHERE m.id=? AND m.tournament_id=?
                 LIMIT 1
                 FOR UPDATE',
                $this->tablePrefix
            ));
            $matchStatement->bind_param('ii', $matchId, $tournamentId);
            $matchStatement->execute();
            $match = $matchStatement->get_result()->fetch_assoc() ?: null;
            $matchStatement->close();

            if ($match === null) {
                throw new ValidationException('match_not_found', 'Kampen finnes ikke i denne turneringen.', 404);
            }

            $status = (string) $match['status'];
            if (!in_array($status, ['pending', 'assigned', 'in_progress'], true)) {
                throw new ValidationException(
                    'match_not_movable',
                    'Bare ventende, oppkalte eller pågående kamper kan flyttes.',
                    409
                );
            }
            if ($status === 'in_progress' && !$confirmInProgress) {
                throw new ValidationException(
                    'match_move_confirmation_required',
                    'Kampen pågår. Bekreft eksplisitt at den skal flyttes.',
                    409
                );
            }

            $boardStatement = $this->connection->prepare(sprintf(
                'SELECT k.id, k.board_number, k.name
                 FROM `%1$skiosks` k
                 INNER JOIN `%1$stournament_kiosks` tk
                   ON tk.kiosk_id=k.id AND tk.tournament_id=?
                 INNER JOIN `%1$stournaments` t
                   ON t.id=tk.tournament_id AND t.club_id=k.club_id
                 WHERE k.id=? AND k.is_active=1
                 LIMIT 1
                 FOR UPDATE',
                $this->tablePrefix
            ));
            $boardStatement->bind_param('ii', $tournamentId, $targetKioskId);
            $boardStatement->execute();
            $board = $boardStatement->get_result()->fetch_assoc() ?: null;
            $boardStatement->close();

            if ($board === null) {
                throw new ValidationException(
                    'target_board_unavailable',
                    'Målskiven er ikke en aktiv, valgt skive for turneringen.',
                    409
                );
            }

            $currentKioskId = (int) ($match['kiosk_id'] ?? 0);
            if ($currentKioskId === $targetKioskId && $status !== 'pending') {
                $this->connection->commit();
                return [
                    'moved' => false,
                    'match_id' => $matchId,
                    'status' => $status,
                    'kiosk_id' => $targetKioskId,
                    'board_number' => (int) $board['board_number'],
                ];
            }

            $busyStatement = $this->connection->prepare(sprintf(
                'SELECT id
                 FROM `%1$smatches`
                 WHERE kiosk_id=?
                   AND id<>?
                   AND status IN ("assigned","in_progress")
                 LIMIT 1
                 FOR UPDATE',
                $this->tablePrefix
            ));
            $busyStatement->bind_param('ii', $targetKioskId, $matchId);
            $busyStatement->execute();
            $busy = $busyStatement->get_result()->fetch_assoc() ?: null;
            $busyStatement->close();
            if ($busy !== null) {
                throw new ValidationException('target_board_busy', 'Målskiven har allerede en aktiv kamp.', 409);
            }

            $reservationStatement = $this->connection->prepare(sprintf(
                'SELECT match_id
                 FROM `%1$stournament_board_reservations`
                 WHERE kiosk_id=?
                 LIMIT 1
                 FOR UPDATE',
                $this->tablePrefix
            ));
            $reservationStatement->bind_param('i', $targetKioskId);
            $reservationStatement->execute();
            $reservation = $reservationStatement->get_result()->fetch_assoc() ?: null;
            $reservationStatement->close();
            if ($reservation !== null && (int) $reservation['match_id'] !== $matchId) {
                throw new ValidationException('target_board_reserved', 'Målskiven er reservert for en annen kamp.', 409);
            }

            $release = $this->connection->prepare(sprintf(
                'DELETE FROM `%1$stournament_board_reservations`
                 WHERE tournament_id=? AND (match_id=? OR kiosk_id=?)',
                $this->tablePrefix
            ));
            $release->bind_param('iii', $tournamentId, $matchId, $targetKioskId);
            $release->execute();
            $release->close();

            if ($status === 'pending') {
                $update = $this->connection->prepare(sprintf(
                    'UPDATE `%1$smatches`
                     SET kiosk_id=?, status="assigned", updated_at=NOW()
                     WHERE id=? AND tournament_id=?',
                    $this->tablePrefix
                ));
            } else {
                $update = $this->connection->prepare(sprintf(
                    'UPDATE `%1$smatches`
                     SET kiosk_id=?, updated_at=NOW()
                     WHERE id=? AND tournament_id=?',
                    $this->tablePrefix
                ));
            }
            $update->bind_param('iii', $targetKioskId, $matchId, $tournamentId);
            $update->execute();
            $update->close();

            $this->connection->commit();

            return [
                'moved' => true,
                'match_id' => $matchId,
                'status' => $status === 'pending' ? 'assigned' : $status,
                'from_kiosk_id' => $currentKioskId > 0 ? $currentKioskId : null,
                'kiosk_id' => $targetKioskId,
                'board_number' => (int) $board['board_number'],
                'player_a_name' => (string) ($match['player_a_name'] ?? ''),
                'player_b_name' => (string) ($match['player_b_name'] ?? ''),
            ];
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /**
     * Permanently removes the tournament and every database row that is structurally owned by it.
     * Caller owns the surrounding transaction so ELO rollback can be atomic with this deletion.
     *
     * @return array<string,int>
     */
    public function hardDeleteTournament(int $tournamentId): array
    {
        $this->requireTournament($tournamentId);

        $matchIds = $this->matchIdsForTournament($tournamentId);
        $groupIds = $this->idsForTournamentTable('tournament_groups', $tournamentId);
        $polymorphicDeleted = $this->deletePolymorphicReferences($tournamentId, $matchIds, $groupIds);

        $rootTable = $this->tablePrefix . 'tournaments';
        $edges = $this->ownershipEdges($rootTable);
        $paths = $this->ownershipPaths($rootTable, $edges);

        usort($paths, static fn (array $left, array $right): int => count($right) <=> count($left));

        $deletedRows = $polymorphicDeleted;
        foreach ($paths as $path) {
            $deletedRows += $this->deleteOwnershipPath($path, $tournamentId);
        }

        $root = $this->connection->prepare(sprintf(
            'DELETE FROM `%s` WHERE id=?',
            $this->identifier($rootTable)
        ));
        $root->bind_param('i', $tournamentId);
        $root->execute();
        $deletedRows += $root->affected_rows;
        $root->close();

        if ($this->tournamentExists($tournamentId)) {
            throw new RuntimeException('Tournament hard delete did not remove the canonical tournament row.');
        }

        return [
            'tournament_id' => $tournamentId,
            'matches' => count($matchIds),
            'deleted_rows' => $deletedRows,
        ];
    }

    /** @return array<string,mixed> */
    private function requireTournament(int $tournamentId): array
    {
        $statement = $this->connection->prepare(sprintf(
            'SELECT id, club_id, status FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        if ($row === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen finnes ikke.', 404);
        }
        return $row;
    }

    private function tournamentExists(int $tournamentId): bool
    {
        $statement = $this->connection->prepare(sprintf(
            'SELECT 1 FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $exists = $statement->get_result()->fetch_assoc() !== null;
        $statement->close();
        return $exists;
    }

    /** @return array<int,array<string,mixed>> */
    private function clubBoards(int $clubId): array
    {
        $statement = $this->connection->prepare(sprintf(
            'SELECT id, board_number, is_active
             FROM `%1$skiosks`
             WHERE club_id=?
             ORDER BY board_number ASC, id ASC',
            $this->tablePrefix
        ));
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();
        return $rows;
    }

    /** @return array<int,int> */
    private function selectedBoardIds(int $tournamentId): array
    {
        $statement = $this->connection->prepare(sprintf(
            'SELECT kiosk_id
             FROM `%1$stournament_kiosks`
             WHERE tournament_id=?
             ORDER BY sort_order ASC, id ASC',
            $this->tablePrefix
        ));
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_values(array_map(static fn (array $row): int => (int) $row['kiosk_id'], $rows));
    }

    /** @return array<int,int> */
    private function idsForTournamentTable(string $suffix, int $tournamentId): array
    {
        $table = $this->tablePrefix . $suffix;
        if (!$this->tableHasColumn($table, 'tournament_id') || !$this->tableHasColumn($table, 'id')) {
            return [];
        }
        $statement = $this->connection->prepare(sprintf(
            'SELECT id FROM `%s` WHERE tournament_id=?',
            $this->identifier($table)
        ));
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_values(array_map(static fn (array $row): int => (int) $row['id'], $rows));
    }

    /**
     * @param array<int,int> $matchIds
     * @param array<int,int> $groupIds
     */
    private function deletePolymorphicReferences(int $tournamentId, array $matchIds, array $groupIds): int
    {
        $columnsByTable = $this->columnsByTable();
        $pairs = [
            ['type' => 'internal_entity_type', 'id' => 'internal_id'],
            ['type' => 'entity_type', 'id' => 'entity_id'],
            ['type' => 'subject_type', 'id' => 'subject_id'],
        ];
        $entities = [
            ['types' => ['tournament', 'tournaments'], 'ids' => [$tournamentId]],
            ['types' => ['match', 'matches', 'tournament_match'], 'ids' => $matchIds],
            ['types' => ['tournament_group'], 'ids' => $groupIds],
        ];

        $deleted = 0;
        foreach ($columnsByTable as $table => $columns) {
            foreach ($pairs as $pair) {
                if (!isset($columns[$pair['type']], $columns[$pair['id']])) {
                    continue;
                }
                foreach ($entities as $entity) {
                    foreach ($entity['ids'] as $id) {
                        if ((int) $id <= 0) {
                            continue;
                        }
                        $typeLiterals = implode(',', array_map(
                            static fn (string $type): string => '"' . $type . '"',
                            $entity['types']
                        ));
                        $sql = sprintf(
                            'DELETE FROM `%1$s`
                             WHERE LOWER(`%2$s`) IN (%3$s) AND `%4$s`=?',
                            $this->identifier($table),
                            $this->identifier($pair['type']),
                            $typeLiterals,
                            $this->identifier($pair['id'])
                        );
                        $statement = $this->connection->prepare($sql);
                        $entityId = (int) $id;
                        $statement->bind_param('i', $entityId);
                        $statement->execute();
                        $deleted += $statement->affected_rows;
                        $statement->close();
                    }
                }
            }
        }
        return $deleted;
    }

    /**
     * @return array<string,array<int,array{child_table:string,child_column:string,parent_table:string,parent_column:string}>>
     */
    private function ownershipEdges(string $rootTable): array
    {
        $edges = [];
        $seen = [];

        $sql = 'SELECT TABLE_NAME AS child_table, COLUMN_NAME AS child_column,
                       REFERENCED_TABLE_NAME AS parent_table, REFERENCED_COLUMN_NAME AS parent_column
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA=DATABASE()
                  AND REFERENCED_TABLE_SCHEMA=DATABASE()
                  AND REFERENCED_TABLE_NAME IS NOT NULL';
        $result = $this->connection->query($sql);
        while ($row = $result->fetch_assoc()) {
            $child = (string) $row['child_table'];
            $parent = (string) $row['parent_table'];
            if (!$this->isApplicationTable($child) || !$this->isApplicationTable($parent)) {
                continue;
            }
            $edge = [
                'child_table' => $child,
                'child_column' => (string) $row['child_column'],
                'parent_table' => $parent,
                'parent_column' => (string) $row['parent_column'],
            ];
            $key = implode('|', $edge);
            if (!isset($seen[$key])) {
                $edges[$parent][] = $edge;
                $seen[$key] = true;
            }
        }
        $result->free();

        $sql = 'SELECT c.TABLE_NAME
                FROM INFORMATION_SCHEMA.COLUMNS c
                INNER JOIN INFORMATION_SCHEMA.TABLES t
                  ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
                WHERE c.TABLE_SCHEMA=DATABASE()
                  AND c.COLUMN_NAME="tournament_id"
                  AND t.TABLE_TYPE="BASE TABLE"';
        $result = $this->connection->query($sql);
        while ($row = $result->fetch_assoc()) {
            $child = (string) $row['TABLE_NAME'];
            if ($child === $rootTable || !$this->isApplicationTable($child)) {
                continue;
            }
            $edge = [
                'child_table' => $child,
                'child_column' => 'tournament_id',
                'parent_table' => $rootTable,
                'parent_column' => 'id',
            ];
            $key = implode('|', $edge);
            if (!isset($seen[$key])) {
                $edges[$rootTable][] = $edge;
                $seen[$key] = true;
            }
        }
        $result->free();

        return $edges;
    }

    /**
     * @param array<string,array<int,array{child_table:string,child_column:string,parent_table:string,parent_column:string}>> $edges
     * @return array<int,array<int,array{child_table:string,child_column:string,parent_table:string,parent_column:string}>>
     */
    private function ownershipPaths(string $rootTable, array $edges): array
    {
        $paths = [];
        $walk = function (string $parent, array $path, array $seenTables) use (&$walk, &$paths, $edges): void {
            foreach ($edges[$parent] ?? [] as $edge) {
                $child = $edge['child_table'];
                if (isset($seenTables[$child])) {
                    continue;
                }
                $nextPath = array_merge($path, [$edge]);
                $paths[] = $nextPath;
                $nextSeen = $seenTables;
                $nextSeen[$child] = true;
                $walk($child, $nextPath, $nextSeen);
            }
        };
        $walk($rootTable, [], [$rootTable => true]);

        return $paths;
    }

    /**
     * @param array<int,array{child_table:string,child_column:string,parent_table:string,parent_column:string}> $path
     */
    private function deleteOwnershipPath(array $path, int $tournamentId): int
    {
        if ($path === []) {
            return 0;
        }

        $last = $path[count($path) - 1];
        $sql = sprintf('DELETE target FROM `%s` target', $this->identifier($last['child_table']));
        $currentAlias = 'target';

        for ($index = count($path) - 1; $index >= 0; $index--) {
            $edge = $path[$index];
            $parentAlias = 'p' . $index;
            $sql .= sprintf(
                ' INNER JOIN `%1$s` %2$s ON %3$s.`%4$s`=%2$s.`%5$s`',
                $this->identifier($edge['parent_table']),
                $parentAlias,
                $currentAlias,
                $this->identifier($edge['child_column']),
                $this->identifier($edge['parent_column'])
            );
            $currentAlias = $parentAlias;
        }

        $sql .= sprintf(' WHERE %s.`id`=?', $currentAlias);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $affected = $statement->affected_rows;
        $statement->close();

        return $affected;
    }

    /** @return array<string,array<string,true>> */
    private function columnsByTable(): array
    {
        $columns = [];
        $result = $this->connection->query(
            'SELECT c.TABLE_NAME, c.COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS c
             INNER JOIN INFORMATION_SCHEMA.TABLES t
               ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
             WHERE c.TABLE_SCHEMA=DATABASE()
               AND t.TABLE_TYPE="BASE TABLE"'
        );
        while ($row = $result->fetch_assoc()) {
            $table = (string) $row['TABLE_NAME'];
            if (!$this->isApplicationTable($table)) {
                continue;
            }
            $columns[$table][(string) $row['COLUMN_NAME']] = true;
        }
        $result->free();
        return $columns;
    }

    private function tableHasColumn(string $table, string $column): bool
    {
        $statement = $this->connection->prepare(
            'SELECT 1
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?
             LIMIT 1'
        );
        $statement->bind_param('ss', $table, $column);
        $statement->execute();
        $exists = $statement->get_result()->fetch_assoc() !== null;
        $statement->close();
        return $exists;
    }

    private function isApplicationTable(string $table): bool
    {
        return $this->tablePrefix === '' || str_starts_with($table, $this->tablePrefix);
    }

    private function identifier(string $identifier): string
    {
        if (preg_match('/^[A-Za-z0-9_$]+$/', $identifier) !== 1) {
            throw new RuntimeException('Unsafe database identifier encountered.');
        }
        return $identifier;
    }
}
