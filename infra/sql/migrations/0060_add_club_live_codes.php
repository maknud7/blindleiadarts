<?php

declare(strict_types=1);

/**
 * Give every club one stable, public four-digit Live code.
 *
 * The code is a short routing identifier, not an authentication secret.
 * The column stays nullable so older/new club creation paths remain backwards
 * compatible; club-live.php lazily assigns a code if a newly created club has none.
 */
return static function (mysqli $connection, string $tablePrefix): void {
    $table = $tablePrefix . 'clubs';

    $column = $connection->prepare(
        'SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1'
    );
    $columnName = 'live_code';
    $column->bind_param('ss', $table, $columnName);
    $column->execute();
    $hasColumn = $column->get_result()->fetch_row() !== null;
    $column->close();

    if (!$hasColumn) {
        $connection->query(sprintf(
            'ALTER TABLE `%s` ADD COLUMN live_code CHAR(4) NULL AFTER kiosk_pairing_code',
            $table
        ));
    }

    $result = $connection->query(sprintf(
        'SELECT id, live_code FROM `%s` ORDER BY id ASC',
        $table
    ));
    $clubs = $result !== false ? $result->fetch_all(MYSQLI_ASSOC) : [];

    $used = [];
    foreach ($clubs as $club) {
        $existing = trim((string) ($club['live_code'] ?? ''));
        if (preg_match('/^\d{4}$/', $existing) === 1) {
            $used[$existing] = true;
        }
    }

    foreach ($clubs as $club) {
        $existing = trim((string) ($club['live_code'] ?? ''));
        if (preg_match('/^\d{4}$/', $existing) === 1) {
            continue;
        }

        do {
            $code = (string) random_int(1000, 9999);
        } while (isset($used[$code]));
        $used[$code] = true;

        $clubId = (int) $club['id'];
        $update = $connection->prepare(sprintf(
            'UPDATE `%s` SET live_code = ? WHERE id = ?',
            $table
        ));
        $update->bind_param('si', $code, $clubId);
        $update->execute();
        $update->close();
    }

    $index = $connection->prepare(
        'SELECT 1 FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1'
    );
    $indexName = 'uq_clubs_live_code';
    $index->bind_param('ss', $table, $indexName);
    $index->execute();
    $hasIndex = $index->get_result()->fetch_row() !== null;
    $index->close();

    if (!$hasIndex) {
        $connection->query(sprintf(
            'ALTER TABLE `%s` ADD UNIQUE KEY uq_clubs_live_code (live_code)',
            $table
        ));
    }
};
