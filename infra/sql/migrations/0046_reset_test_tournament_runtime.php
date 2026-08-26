<?php

declare(strict_types=1);

/**
 * One-time cleanup of tournament runtime data in the TEST schema only.
 *
 * Identity and hardware are shared with production in the test environment.
 * This migration therefore refuses to run for any prefix other than bd_test_
 * and deliberately does not touch clubs, seasons, players, users, kiosks,
 * screen devices or Scolia board settings/runtime.
 */
return static function (mysqli $db, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "Skipping test tournament reset for non-test prefix: {$prefix}" . PHP_EOL);
        return;
    }

    $tableExists = static function (mysqli $db, string $table): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
        );
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    $deleteAll = static function (mysqli $db, string $table, callable $tableExists): int {
        if (!$tableExists($db, $table)) {
            return 0;
        }
        $countResult = $db->query("SELECT COUNT(*) AS c FROM `{$table}`");
        $count = (int) ($countResult->fetch_assoc()['c'] ?? 0);
        $countResult->free();
        if ($count > 0) {
            $db->query("DELETE FROM `{$table}`");
        }
        return $count;
    };

    $deleted = [];
    $db->begin_transaction();

    try {
        // Derived competition state must be reset as well. Current ratings are
        // materialized from match events and would otherwise survive the matches.
        foreach ([
            'elo_current_ratings',
            'ranking_snapshots',
            'visits',
            'legs',
            'matches',
            'tournament_players',
            'tournaments',
        ] as $suffix) {
            $table = $prefix . $suffix;
            $deleted[$suffix] = $deleteAll($db, $table, $tableExists);
        }

        // Old connector references are polymorphic and do not have foreign keys.
        $externalReferences = $prefix . 'external_references';
        if ($tableExists($db, $externalReferences)) {
            $db->query(
                "DELETE FROM `{$externalReferences}`
                 WHERE `internal_entity_type` IN ('tournament','match','leg','visit','tournament_group','playoff')"
            );
            $deleted['external_references'] = $db->affected_rows;
        }

        $syncJobs = $prefix . 'connector_sync_jobs';
        if ($tableExists($db, $syncJobs)) {
            $db->query(
                "DELETE FROM `{$syncJobs}`
                 WHERE `scope_entity_type` IN ('tournament','match','leg','visit','tournament_group','playoff')"
            );
            $deleted['connector_sync_jobs'] = $db->affected_rows;
        }

        // Sanity checks before committing. These are the three core tables that
        // must be empty for a genuinely fresh tournament test.
        foreach (['tournaments', 'matches', 'tournament_players'] as $suffix) {
            $table = $prefix . $suffix;
            if (!$tableExists($db, $table)) {
                continue;
            }
            $result = $db->query("SELECT COUNT(*) AS c FROM `{$table}`");
            $remaining = (int) ($result->fetch_assoc()['c'] ?? 0);
            $result->free();
            if ($remaining !== 0) {
                throw new RuntimeException("Test cleanup failed: {$table} still contains {$remaining} row(s).");
            }
        }

        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    fwrite(STDOUT, 'Test tournament runtime reset complete: ' . json_encode($deleted, JSON_UNESCAPED_SLASHES) . PHP_EOL);
};
