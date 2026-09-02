<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $table = $prefix . 'tournament_elo_snapshots';

    $hasColumn = static function (string $column) use ($mysqli, $table): bool {
        $escaped = $mysqli->real_escape_string($column);
        $result = $mysqli->query("SHOW COLUMNS FROM `{$table}` LIKE '{$escaped}'");
        $exists = $result->num_rows > 0;
        $result->free();
        return $exists;
    };

    if (!$hasColumn('rank_before')) {
        $mysqli->query("ALTER TABLE `{$table}` ADD COLUMN `rank_before` INT UNSIGNED NULL AFTER `elo_after`");
    }
    if (!$hasColumn('rank_after')) {
        $mysqli->query("ALTER TABLE `{$table}` ADD COLUMN `rank_after` INT UNSIGNED NULL AFTER `rank_before`");
    }
    if (!$hasColumn('rank_baseline_kind')) {
        $mysqli->query("ALTER TABLE `{$table}` ADD COLUMN `rank_baseline_kind` VARCHAR(16) NOT NULL DEFAULT 'start' AFTER `rank_after`");
    }
};