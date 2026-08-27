<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $baselinePath = dirname(__DIR__, 3) . '/apps/api/data/mandagsserien-elo-2026-08-24.php';
    if (!is_file($baselinePath)) {
        return;
    }

    $baseline = require $baselinePath;
    $baselinePlayers = (array) ($baseline['players'] ?? []);
    if ($baselinePlayers === []) {
        return;
    }

    $byName = [];
    foreach ($baselinePlayers as $entry) {
        $name = trim((string) ($entry['display_name'] ?? ''));
        if ($name === '') {
            continue;
        }
        $byName[mb_strtolower($name, 'UTF-8')] = [
            'rating' => (float) ($entry['rating'] ?? 1000.0),
            'played' => (int) ($entry['played'] ?? 0),
        ];
    }
    if ($byName === []) {
        return;
    }

    $seasonsTable = $prefix . 'seasons';
    $playersTable = $prefix . 'players';
    $currentTable = $prefix . 'elo_current_ratings';

    $seasonRows = $mysqli->query(
        "SELECT id, club_id FROM `{$seasonsTable}` WHERE is_active=1 ORDER BY id DESC"
    )->fetch_all(MYSQLI_ASSOC);
    $activeSeasonByClub = [];
    foreach ($seasonRows as $row) {
        $clubId = (int) ($row['club_id'] ?? 0);
        if ($clubId > 0 && !isset($activeSeasonByClub[$clubId])) {
            $activeSeasonByClub[$clubId] = (int) $row['id'];
        }
    }
    if ($activeSeasonByClub === []) {
        return;
    }

    $players = $mysqli->query(
        "SELECT id, club_id, display_name FROM `{$playersTable}` WHERE is_active=1 ORDER BY id ASC"
    )->fetch_all(MYSQLI_ASSOC);

    $select = $mysqli->prepare(
        "SELECT rating, matches_played, last_event_id FROM `{$currentTable}` WHERE season_id=? AND player_id=? LIMIT 1"
    );
    $insert = $mysqli->prepare(
        "INSERT INTO `{$currentTable}` (season_id, player_id, rating, matches_played, last_event_id) VALUES (?, ?, ?, ?, NULL)"
    );
    $update = $mysqli->prepare(
        "UPDATE `{$currentTable}` SET rating=?, matches_played=? WHERE season_id=? AND player_id=?"
    );

    foreach ($players as $player) {
        $clubId = (int) ($player['club_id'] ?? 0);
        $seasonId = (int) ($activeSeasonByClub[$clubId] ?? 0);
        if ($seasonId <= 0) {
            continue;
        }

        $key = mb_strtolower(trim((string) ($player['display_name'] ?? '')), 'UTF-8');
        if ($key === '' || !isset($byName[$key])) {
            continue;
        }

        $playerId = (int) $player['id'];
        $rating = (float) $byName[$key]['rating'];
        $played = (int) $byName[$key]['played'];

        $select->bind_param('ii', $seasonId, $playerId);
        $select->execute();
        $existing = $select->get_result()->fetch_assoc() ?: null;

        if ($existing === null) {
            $insert->bind_param('iidi', $seasonId, $playerId, $rating, $played);
            $insert->execute();
            continue;
        }

        $existingRating = (float) ($existing['rating'] ?? 1000.0);
        $existingPlayed = (int) ($existing['matches_played'] ?? 0);
        $lastEventId = $existing['last_event_id'] !== null ? (int) $existing['last_event_id'] : null;

        // Only repair untouched default rows. Never overwrite ELO that has already
        // been advanced by the canonical match-event ledger.
        if ($lastEventId === null && $existingPlayed === 0 && abs($existingRating - 1000.0) < 0.000001) {
            $update->bind_param('diii', $rating, $played, $seasonId, $playerId);
            $update->execute();
        }
    }

    $select->close();
    $insert->close();
    $update->close();
};
