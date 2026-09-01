<?php

declare(strict_types=1);

/**
 * Persist the wall-display visual profile per club.
 *
 * `blindleia` keeps the established blue/white club identity.
 * `broadcast-dark` is the denser dark TV/scoreboard profile.
 */
return static function (mysqli $connection, string $tablePrefix): void {
    $table = $tablePrefix . 'clubs';
    $columnName = 'live_display_profile';

    $column = $connection->prepare(
        'SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1'
    );
    $column->bind_param('ss', $table, $columnName);
    $column->execute();
    $hasColumn = $column->get_result()->fetch_row() !== null;
    $column->close();

    if (!$hasColumn) {
        $connection->query(sprintf(
            "ALTER TABLE `%s` ADD COLUMN live_display_profile VARCHAR(32) NOT NULL DEFAULT 'blindleia' AFTER live_code",
            $table
        ));
    }

    $connection->query(sprintf(
        "UPDATE `%s` SET live_display_profile = 'blindleia' WHERE live_display_profile IS NULL OR live_display_profile NOT IN ('blindleia','broadcast-dark')",
        $table
    ));
};
