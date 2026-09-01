<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        return;
    }

    $tournaments = $prefix . 'tournaments';
    $tournamentKiosks = $prefix . 'tournament_kiosks';
    $migrations = $prefix . 'schema_migrations';

    $migrationName = '0072_materialize_legacy_tournament_boards.sql';
    $stampStmt = $mysqli->prepare(
        "SELECT applied_at FROM `{$migrations}` WHERE migration_name=? LIMIT 1"
    );
    $stampStmt->bind_param('s', $migrationName);
    $stampStmt->execute();
    $migration = $stampStmt->get_result()->fetch_assoc() ?: null;
    $stampStmt->close();

    if ($migration === null) {
        fwrite(STDOUT, "TEST_LEGACY_BOARD_CLEANUP skipped=no_0072_stamp\n");
        return;
    }

    $appliedAt = (string) $migration['applied_at'];

    // 0072 originally included draft/ready for one TEST deployment. It inserted an
    // entire implicit board set in one statement, so all rows it created for a
    // tournament share the migration timestamp window. Only remove draft/ready
    // selections where every row belongs to that narrow window; explicit selections
    // created earlier are therefore left untouched.
    $candidateStmt = $mysqli->prepare(
        "SELECT tk.tournament_id
         FROM `{$tournamentKiosks}` tk
         INNER JOIN `{$tournaments}` t ON t.id=tk.tournament_id
         WHERE t.status IN ('draft','ready')
         GROUP BY tk.tournament_id
         HAVING MIN(tk.created_at) >= DATE_SUB(?, INTERVAL 5 SECOND)
            AND MAX(tk.created_at) <= DATE_ADD(?, INTERVAL 1 SECOND)"
    );
    $candidateStmt->bind_param('ss', $appliedAt, $appliedAt);
    $candidateStmt->execute();
    $candidateIds = array_map(
        static fn (array $row): int => (int) $row['tournament_id'],
        $candidateStmt->get_result()->fetch_all(MYSQLI_ASSOC)
    );
    $candidateStmt->close();

    $deleted = 0;
    if ($candidateIds !== []) {
        $ids = implode(',', array_map('intval', $candidateIds));
        $mysqli->begin_transaction();
        try {
            $result = $mysqli->query(
                "DELETE FROM `{$tournamentKiosks}` WHERE tournament_id IN ({$ids})"
            );
            $deleted = $mysqli->affected_rows;
            $mysqli->commit();
        } catch (Throwable $error) {
            $mysqli->rollback();
            throw $error;
        }
    }

    fwrite(STDOUT, sprintf(
        "TEST_LEGACY_BOARD_CLEANUP tournaments=%d rows=%d\n",
        count($candidateIds),
        $deleted
    ));
};
