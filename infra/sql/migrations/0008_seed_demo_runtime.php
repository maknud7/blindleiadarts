<?php

declare(strict_types=1);

use mysqli;

return static function (mysqli $mysqli, string $prefix): void {
    $clubSlug = 'blindleia-dartklubb';
    $seasonName = date('Y') . ' Season';
    $tournamentName = 'Blindleia Test Cup';
    $tournamentSlug = 'blindleia-test-cup';
    $kiosks = [
        ['code' => 'BOARD-1', 'name' => 'Board 1', 'board_number' => 1, 'sponsor_label' => 'Sparebanken Norge', 'sponsor_logo_url' => '/static/sponsors/demo-sparebanken-norge.svg', 'scoring_mode' => 'manual'],
        ['code' => 'BOARD-2', 'name' => 'Board 2', 'board_number' => 2, 'sponsor_label' => 'MENY Lillesand', 'sponsor_logo_url' => '/static/sponsors/demo-meny-lillesand.svg', 'scoring_mode' => 'manual'],
        ['code' => 'BOARD-3', 'name' => 'Board 3', 'board_number' => 3, 'sponsor_label' => 'Monter Lillesand', 'sponsor_logo_url' => '/static/sponsors/demo-monter-lillesand.svg', 'scoring_mode' => 'manual'],
        ['code' => 'BOARD-4', 'name' => 'Board 4', 'board_number' => 4, 'sponsor_label' => 'Circle K E18 Lillesand', 'sponsor_logo_url' => '/static/sponsors/demo-circlek-lillesand.svg', 'scoring_mode' => 'manual'],
    ];
    $samplePlayers = [
        'Andre Kendrick',
        'Bjørn Jarle Jahnsen',
        'Andreas Tingstveit Hansen',
        'Thomas Kildal',
        'Andre Hammer',
        'Boye Buckingham',
        'Magnus Knudsen',
        'Vetle Ribe Davidsen',
    ];

    $clubId = fetch_single_id($mysqli, "SELECT id FROM `{$prefix}clubs` WHERE slug = ? LIMIT 1", 's', [$clubSlug]);
    if ($clubId === null) {
        return;
    }

    $seasonId = fetch_single_id(
        $mysqli,
        "SELECT id FROM `{$prefix}seasons` WHERE club_id = ? AND name = ? LIMIT 1",
        'is',
        [$clubId, $seasonName]
    );
    if ($seasonId === null) {
        return;
    }

    $tournamentId = fetch_single_id(
        $mysqli,
        "SELECT id FROM `{$prefix}tournaments` WHERE slug = ? LIMIT 1",
        's',
        [$tournamentSlug]
    );

    if ($tournamentId === null) {
        $providerSystem = 'local';
        $status = 'ready';
        $maxVisitsPerLeg = 50;
        $startAt = date('Y-m-d 19:00:00');
        $endAt = null;

        $insertTournament = $mysqli->prepare(
            "INSERT INTO `{$prefix}tournaments`
             (club_id, season_id, name, slug, provider_system, status, max_visits_per_leg, start_at, end_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        $insertTournament->bind_param(
            'iissssiss',
            $clubId,
            $seasonId,
            $tournamentName,
            $tournamentSlug,
            $providerSystem,
            $status,
            $maxVisitsPerLeg,
            $startAt,
            $endAt
        );
        $insertTournament->execute();
        $tournamentId = (int) $insertTournament->insert_id;
        $insertTournament->close();
    }

    $kioskIds = [];
    foreach ($kiosks as $kiosk) {
        $kioskId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}kiosks` WHERE code = ? LIMIT 1",
            's',
            [$kiosk['code']]
        );

        if ($kioskId === null) {
            $isActive = 1;
            $sponsorLogoUrl = $kiosk['sponsor_logo_url'] ?? null;
            $insertKiosk = $mysqli->prepare(
                "INSERT INTO `{$prefix}kiosks`
                 (club_id, code, name, board_number, sponsor_label, sponsor_logo_url, scoring_mode, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            );
            $insertKiosk->bind_param(
                'ississsi',
                $clubId,
                $kiosk['code'],
                $kiosk['name'],
                $kiosk['board_number'],
                $kiosk['sponsor_label'],
                $sponsorLogoUrl,
                $kiosk['scoring_mode'],
                $isActive
            );
            $insertKiosk->execute();
            $kioskId = (int) $insertKiosk->insert_id;
            $insertKiosk->close();
        } else {
            $sponsorLogoUrl = $kiosk['sponsor_logo_url'] ?? null;
            $updateKiosk = $mysqli->prepare(
                "UPDATE `{$prefix}kiosks`
                 SET `name` = ?, `board_number` = ?, `sponsor_label` = ?, `sponsor_logo_url` = ?, `scoring_mode` = ?
                 WHERE `id` = ?"
            );
            $updateKiosk->bind_param(
                'sisssi',
                $kiosk['name'],
                $kiosk['board_number'],
                $kiosk['sponsor_label'],
                $sponsorLogoUrl,
                $kiosk['scoring_mode'],
                $kioskId
            );
            $updateKiosk->execute();
            $updateKiosk->close();
        }

        $kioskIds[$kiosk['code']] = $kioskId;
    }

    $playerIds = [];
    foreach ($samplePlayers as $displayName) {
        $playerId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}players` WHERE display_name = ? LIMIT 1",
            's',
            [$displayName]
        );

        if ($playerId === null) {
            continue;
        }

        $playerIds[$displayName] = $playerId;

        $registrationId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}tournament_players` WHERE tournament_id = ? AND player_id = ? LIMIT 1",
            'ii',
            [$tournamentId, $playerId]
        );

        if ($registrationId === null) {
            $status = 'registered';
            $insertRegistration = $mysqli->prepare(
                "INSERT INTO `{$prefix}tournament_players` (tournament_id, player_id, status) VALUES (?, ?, ?)"
            );
            $insertRegistration->bind_param('iis', $tournamentId, $playerId, $status);
            $insertRegistration->execute();
            $insertRegistration->close();
        }
    }

    $matches = [
        [
            'round_label' => 'Kvartfinale 1',
            'bracket_label' => 'Winners bracket',
            'status' => 'assigned',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andre Kendrick',
            'player_b' => 'Bjørn Jarle Jahnsen',
            'kiosk_code' => 'BOARD-1',
        ],
        [
            'round_label' => 'Kvartfinale 2',
            'bracket_label' => 'Winners bracket',
            'status' => 'assigned',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andreas Tingstveit Hansen',
            'player_b' => 'Thomas Kildal',
            'kiosk_code' => 'BOARD-2',
        ],
        [
            'round_label' => 'Oppvarmingskamp',
            'bracket_label' => 'Friendly',
            'status' => 'completed',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Magnus Knudsen',
            'player_b' => 'Vetle Ribe Davidsen',
            'kiosk_code' => 'BOARD-1',
        ],
    ];

    foreach ($matches as $match) {
        $playerAId = $playerIds[$match['player_a']] ?? null;
        $playerBId = $playerIds[$match['player_b']] ?? null;
        $kioskId = $kioskIds[$match['kiosk_code']] ?? null;

        if ($playerAId === null || $playerBId === null || $kioskId === null) {
            continue;
        }

        $matchId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}matches` WHERE tournament_id = ? AND round_label = ? LIMIT 1",
            'is',
            [$tournamentId, $match['round_label']]
        );

        if ($matchId === null) {
            $startsAt = $match['status'] === 'completed' ? date('Y-m-d 18:00:00') : null;
            $finishedAt = $match['status'] === 'completed' ? date('Y-m-d 18:20:00') : null;
            $winnerPlayerId = $match['status'] === 'completed' ? $playerAId : null;
            $insertMatch = $mysqli->prepare(
                "INSERT INTO `{$prefix}matches`
                 (tournament_id, kiosk_id, round_label, bracket_label, status, best_of_legs, legs_to_win, player_a_id, player_b_id, winner_player_id, starts_at, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            );
            $insertMatch->bind_param(
                'iisssiiiiiss',
                $tournamentId,
                $kioskId,
                $match['round_label'],
                $match['bracket_label'],
                $match['status'],
                $match['best_of_legs'],
                $match['legs_to_win'],
                $playerAId,
                $playerBId,
                $winnerPlayerId,
                $startsAt,
                $finishedAt
            );
            $insertMatch->execute();
            $matchId = (int) $insertMatch->insert_id;
            $insertMatch->close();
        }

        if ($match['status'] !== 'completed') {
            continue;
        }

        $legId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}legs` WHERE match_id = ? AND leg_number = 1 LIMIT 1",
            'i',
            [$matchId]
        );

        if ($legId === null) {
            $status = 'completed';
            $startScore = 501;
            $finishedAt = date('Y-m-d 18:10:00');
            $insertLeg = $mysqli->prepare(
                "INSERT INTO `{$prefix}legs` (match_id, leg_number, starting_player_id, winner_player_id, status, start_score, finished_at)
                 VALUES (?, 1, ?, ?, ?, ?, ?)"
            );
            $insertLeg->bind_param('iiisis', $matchId, $playerAId, $playerAId, $status, $startScore, $finishedAt);
            $insertLeg->execute();
            $legId = (int) $insertLeg->insert_id;
            $insertLeg->close();
        }

        $visitId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}visits` WHERE match_id = ? AND leg_id = ? LIMIT 1",
            'ii',
            [$matchId, $legId]
        );

        if ($visitId === null) {
            $inputMode = 'sum';
            $isBust = 0;
            $remainingAfter = 361;
            $dartsJson = null;
            $insertVisit = $mysqli->prepare(
                "INSERT INTO `{$prefix}visits`
                 (match_id, leg_id, player_id, visit_number, score, darts_used, input_mode, darts_json, is_bust, remaining_after)
                 VALUES (?, ?, ?, 1, 140, 3, ?, ?, ?, ?)"
            );
            $insertVisit->bind_param('iiissii', $matchId, $legId, $playerAId, $inputMode, $dartsJson, $isBust, $remainingAfter);
            $insertVisit->execute();
            $insertVisit->close();
        }
    }

    $rankings = [
        ['player' => 'Andre Kendrick', 'type' => 'elo', 'points' => 1544.00, 'position' => 1],
        ['player' => 'Bjørn Jarle Jahnsen', 'type' => 'elo', 'points' => 1531.00, 'position' => 2],
        ['player' => 'Magnus Knudsen', 'type' => 'elo', 'points' => 1498.00, 'position' => 3],
        ['player' => 'Andre Kendrick', 'type' => 'order_of_merit', 'points' => 43.00, 'position' => 1],
        ['player' => 'Bjørn Jarle Jahnsen', 'type' => 'order_of_merit', 'points' => 37.00, 'position' => 2],
        ['player' => 'Andreas Tingstveit Hansen', 'type' => 'order_of_merit', 'points' => 35.00, 'position' => 3],
    ];

    foreach ($rankings as $ranking) {
        $playerId = $playerIds[$ranking['player']] ?? null;
        if ($playerId === null) {
            continue;
        }

        $exists = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}ranking_snapshots`
             WHERE season_id = ? AND tournament_id IS NULL AND player_id = ? AND ranking_type = ? AND scope_type = 'season'
             LIMIT 1",
            'iis',
            [$seasonId, $playerId, $ranking['type']]
        );

        if ($exists !== null) {
            continue;
        }

        $scopeType = 'season';
        $contextJson = json_encode(['source' => 'demo-seed'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $insertRanking = $mysqli->prepare(
            "INSERT INTO `{$prefix}ranking_snapshots`
             (season_id, tournament_id, player_id, ranking_type, scope_type, points, position, context_json)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?)"
        );
        $insertRanking->bind_param(
            'iissdis',
            $seasonId,
            $playerId,
            $ranking['type'],
            $scopeType,
            $ranking['points'],
            $ranking['position'],
            $contextJson
        );
        $insertRanking->execute();
        $insertRanking->close();
    }
};

/**
 * @param array<int, mixed> $values
 */
function fetch_single_id(mysqli $mysqli, string $sql, string $types, array $values): ?int
{
    $statement = $mysqli->prepare($sql);
    if ($statement === false) {
        return null;
    }

    $statement->bind_param($types, ...$values);
    $statement->execute();
    $result = $statement->get_result();
    $row = $result->fetch_assoc();
    $statement->close();

    return $row !== null && isset($row['id']) ? (int) $row['id'] : null;
}
