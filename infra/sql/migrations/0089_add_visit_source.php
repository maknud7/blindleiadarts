<?php

declare(strict_types=1);

/**
 * Preserve canonical visit provenance independently of request deduplication.
 *
 * Old visits with no reliable origin stay "legacy"; never label historical
 * imports as manual without evidence. Known Scolia/manual request-key formats
 * are safe to backfill. Newly routed PHP/Node scoring always supplies source.
 * Defaults keep older writers compatible during a staged deploy.
 */
return static function (mysqli $mysqli, string $prefix): void {
    $table = $prefix . 'visits';
    $stmt = $mysqli->prepare(
        'SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
    );
    $column = 'source';
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();

    if (!$exists) {
        $mysqli->query(
            "ALTER TABLE `{$table}`
             ADD COLUMN `source` VARCHAR(24) NOT NULL DEFAULT 'legacy' AFTER `request_key`"
        );
    }

    $mysqli->query(
        "UPDATE `{$table}` SET source='scolia'
          WHERE source='legacy' AND request_key LIKE 'scolia-%'"
    );
    $mysqli->query(
        "UPDATE `{$table}` SET source='manual'
          WHERE source='legacy' AND request_key LIKE 'manual:%'"
    );
};
