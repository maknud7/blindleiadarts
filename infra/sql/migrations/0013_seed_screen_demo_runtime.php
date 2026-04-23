<?php

declare(strict_types=1);

use mysqli;

return static function (mysqli $mysqli, string $prefix): void {
    $clubSlug = 'blindleia-dartklubb';
    $tournamentSlug = 'blindleia-test-cup';
    $screenCode = 'BLI-SCREEN';

    $clubId = fetch_single_id(
        $mysqli,
        "SELECT id FROM `{$prefix}clubs` WHERE slug = ? LIMIT 1",
        's',
        [$clubSlug]
    );

    if ($clubId === null) {
        return;
    }

    $screenDeviceId = fetch_single_id(
        $mysqli,
        "SELECT id FROM `{$prefix}screen_devices` WHERE access_code = ? LIMIT 1",
        's',
        [$screenCode]
    );

    if ($screenDeviceId === null) {
        $label = 'Hovedskjerm';
        $accessToken = bin2hex(random_bytes(24));
        $isActive = 1;
        $insertScreen = $mysqli->prepare(
            "INSERT INTO `{$prefix}screen_devices` (club_id, label, access_code, access_token, is_active)
             VALUES (?, ?, ?, ?, ?)"
        );
        $insertScreen->bind_param('isssi', $clubId, $label, $screenCode, $accessToken, $isActive);
        $insertScreen->execute();
        $insertScreen->close();
    }

    $tournamentId = fetch_single_id(
        $mysqli,
        "SELECT id FROM `{$prefix}tournaments` WHERE slug = ? LIMIT 1",
        's',
        [$tournamentSlug]
    );

    if ($tournamentId === null) {
        return;
    }

    $seasonId = fetch_single_id(
        $mysqli,
        "SELECT season_id AS id FROM `{$prefix}tournaments` WHERE id = ? LIMIT 1",
        'i',
        [$tournamentId]
    );

    $updateTournament = $mysqli->prepare(
        "UPDATE `{$prefix}tournaments`
         SET status = 'in_progress', start_at = COALESCE(start_at, ?)
         WHERE id = ?"
    );
    $startAt = date('Y-m-d 19:00:00');
    $updateTournament->bind_param('si', $startAt, $tournamentId);
    $updateTournament->execute();
    $updateTournament->close();

    $players = load_players_by_name($mysqli, $prefix, [
        'Andre Kendrick',
        'Bjørn Jarle Jahnsen',
        'Andreas Tingstveit Hansen',
        'Thomas Kildal',
        'Andre Hammer',
        'Boye Buckingham',
        'Vetle Ribe Davidsen',
        'Geir Atle Håland',
    ]);

    $kiosks = load_kiosks_by_code($mysqli, $prefix, [
        'BOARD-1',
        'BOARD-2',
        'BOARD-3',
        'BOARD-4',
    ]);

    $matches = [
        [
            'round_label' => 'Kvartfinale 1',
            'bracket_label' => 'Winners bracket',
            'status' => 'in_progress',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andre Kendrick',
            'player_b' => 'Bjørn Jarle Jahnsen',
            'kiosk_code' => 'BOARD-1',
            'starts_at' => date('Y-m-d 19:05:00'),
        ],
        [
            'round_label' => 'Kvartfinale 2',
            'bracket_label' => 'Winners bracket',
            'status' => 'in_progress',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andreas Tingstveit Hansen',
            'player_b' => 'Thomas Kildal',
            'kiosk_code' => 'BOARD-2',
            'starts_at' => date('Y-m-d 19:08:00'),
        ],
        [
            'round_label' => 'Kvartfinale 3',
            'bracket_label' => 'Winners bracket',
            'status' => 'assigned',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andre Hammer',
            'player_b' => 'Boye Buckingham',
            'kiosk_code' => 'BOARD-3',
            'starts_at' => null,
        ],
        [
            'round_label' => 'Kvartfinale 4',
            'bracket_label' => 'Winners bracket',
            'status' => 'assigned',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Vetle Ribe Davidsen',
            'player_b' => 'Geir Atle Håland',
            'kiosk_code' => 'BOARD-4',
            'starts_at' => null,
        ],
        [
            'round_label' => 'Semifinale 1',
            'bracket_label' => 'Winners bracket',
            'status' => 'pending',
            'best_of_legs' => 5,
            'legs_to_win' => 3,
            'player_a' => 'Andre Kendrick',
            'player_b' => 'Andreas Tingstveit Hansen',
            'kiosk_code' => null,
            'starts_at' => null,
        ],
        [
            'round_label' => 'Semifinale 2',
            'bracket_label' => 'Winners bracket',
            'status' => 'pending',
            'best_of_legs' => 5,
            'legs_to_win' => 3,
            'player_a' => 'Andre Hammer',
            'player_b' => 'Vetle Ribe Davidsen',
            'kiosk_code' => null,
            'starts_at' => null,
        ],
        [
            'round_label' => 'Rankingkamp 1',
            'bracket_label' => 'Placement',
            'status' => 'completed',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andre Kendrick',
            'player_b' => 'Boye Buckingham',
            'winner' => 'Andre Kendrick',
            'kiosk_code' => 'BOARD-1',
            'starts_at' => date('Y-m-d 18:05:00'),
            'finished_at' => date('Y-m-d 18:24:00'),
        ],
        [
            'round_label' => 'Rankingkamp 2',
            'bracket_label' => 'Placement',
            'status' => 'completed',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Thomas Kildal',
            'player_b' => 'Vetle Ribe Davidsen',
            'winner' => 'Thomas Kildal',
            'kiosk_code' => 'BOARD-2',
            'starts_at' => date('Y-m-d 18:30:00'),
            'finished_at' => date('Y-m-d 18:47:00'),
        ],
        [
            'round_label' => 'Rankingkamp 3',
            'bracket_label' => 'Placement',
            'status' => 'completed',
            'best_of_legs' => 3,
            'legs_to_win' => 2,
            'player_a' => 'Andre Hammer',
            'player_b' => 'Geir Atle Håland',
            'winner' => 'Andre Hammer',
            'kiosk_code' => 'BOARD-3',
            'starts_at' => date('Y-m-d 18:50:00'),
            'finished_at' => date('Y-m-d 19:06:00'),
        ],
    ];

    foreach ($matches as $match) {
        $playerAId = $players[$match['player_a']] ?? null;
        $playerBId = $players[$match['player_b']] ?? null;
        $kioskId = $match['kiosk_code'] !== null ? ($kiosks[$match['kiosk_code']] ?? null) : null;

        if ($playerAId === null || $playerBId === null) {
            continue;
        }

        $matchId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}matches` WHERE tournament_id = ? AND round_label = ? LIMIT 1",
            'is',
            [$tournamentId, $match['round_label']]
        );

        $winnerId = isset($match['winner']) ? ($players[$match['winner']] ?? null) : null;

        if ($matchId === null) {
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
                $winnerId,
                $match['starts_at'],
                $match['finished_at'] ?? null
            );
            $insertMatch->execute();
            $matchId = (int) $insertMatch->insert_id;
            $insertMatch->close();
        } else {
            $updateMatch = $mysqli->prepare(
                "UPDATE `{$prefix}matches`
                 SET kiosk_id = ?, bracket_label = ?, status = ?, best_of_legs = ?, legs_to_win = ?,
                     player_a_id = ?, player_b_id = ?, winner_player_id = ?, starts_at = ?, finished_at = ?
                 WHERE id = ?"
            );
            $updateMatch->bind_param(
                'issiiiiissi',
                $kioskId,
                $match['bracket_label'],
                $match['status'],
                $match['best_of_legs'],
                $match['legs_to_win'],
                $playerAId,
                $playerBId,
                $winnerId,
                $match['starts_at'],
                $match['finished_at'] ?? null,
                $matchId
            );
            $updateMatch->execute();
            $updateMatch->close();
        }
    }

    $liveVisits = [
        [
            'match' => 'Kvartfinale 1',
            'legs' => [
                [
                    'leg_number' => 1,
                    'starting_player' => 'Andre Kendrick',
                    'winner' => null,
                    'status' => 'in_progress',
                    'visits' => [
                        ['player' => 'Andre Kendrick', 'visit_number' => 1, 'score' => 100, 'remaining_after' => 401],
                        ['player' => 'Bjørn Jarle Jahnsen', 'visit_number' => 1, 'score' => 60, 'remaining_after' => 441],
                        ['player' => 'Andre Kendrick', 'visit_number' => 2, 'score' => 140, 'remaining_after' => 261],
                        ['player' => 'Bjørn Jarle Jahnsen', 'visit_number' => 2, 'score' => 85, 'remaining_after' => 356],
                    ],
                ],
            ],
        ],
        [
            'match' => 'Kvartfinale 2',
            'legs' => [
                [
                    'leg_number' => 1,
                    'starting_player' => 'Andreas Tingstveit Hansen',
                    'winner' => 'Andreas Tingstveit Hansen',
                    'status' => 'completed',
                    'finished_at' => date('Y-m-d 19:12:00'),
                    'visits' => [
                        ['player' => 'Andreas Tingstveit Hansen', 'visit_number' => 1, 'score' => 81, 'remaining_after' => 420],
                        ['player' => 'Thomas Kildal', 'visit_number' => 1, 'score' => 60, 'remaining_after' => 441],
                        ['player' => 'Andreas Tingstveit Hansen', 'visit_number' => 2, 'score' => 140, 'remaining_after' => 280],
                        ['player' => 'Thomas Kildal', 'visit_number' => 2, 'score' => 100, 'remaining_after' => 341],
                        ['player' => 'Andreas Tingstveit Hansen', 'visit_number' => 3, 'score' => 95, 'remaining_after' => 185],
                        ['player' => 'Thomas Kildal', 'visit_number' => 3, 'score' => 85, 'remaining_after' => 256],
                        ['player' => 'Andreas Tingstveit Hansen', 'visit_number' => 4, 'score' => 125, 'remaining_after' => 60],
                        ['player' => 'Thomas Kildal', 'visit_number' => 4, 'score' => 96, 'remaining_after' => 160],
                        ['player' => 'Andreas Tingstveit Hansen', 'visit_number' => 5, 'score' => 60, 'remaining_after' => 0],
                    ],
                ],
                [
                    'leg_number' => 2,
                    'starting_player' => 'Thomas Kildal',
                    'winner' => null,
                    'status' => 'in_progress',
                    'visits' => [
                        ['player' => 'Thomas Kildal', 'visit_number' => 1, 'score' => 140, 'remaining_after' => 361],
                        ['player' => 'Andreas Tingstveit Hansen', 'visit_number' => 1, 'score' => 59, 'remaining_after' => 442],
                        ['player' => 'Thomas Kildal', 'visit_number' => 2, 'score' => 100, 'remaining_after' => 261],
                    ],
                ],
            ],
        ],
        [
            'match' => 'Rankingkamp 1',
            'legs' => [
                [
                    'leg_number' => 1,
                    'starting_player' => 'Andre Kendrick',
                    'winner' => 'Andre Kendrick',
                    'status' => 'completed',
                    'finished_at' => date('Y-m-d 18:14:00'),
                    'visits' => [
                        ['player' => 'Andre Kendrick', 'visit_number' => 1, 'score' => 140, 'remaining_after' => 361],
                        ['player' => 'Boye Buckingham', 'visit_number' => 1, 'score' => 60, 'remaining_after' => 441],
                        ['player' => 'Andre Kendrick', 'visit_number' => 2, 'score' => 134, 'remaining_after' => 227],
                        ['player' => 'Boye Buckingham', 'visit_number' => 2, 'score' => 85, 'remaining_after' => 356],
                        ['player' => 'Andre Kendrick', 'visit_number' => 3, 'score' => 95, 'remaining_after' => 132],
                        ['player' => 'Boye Buckingham', 'visit_number' => 3, 'score' => 100, 'remaining_after' => 256],
                        ['player' => 'Andre Kendrick', 'visit_number' => 4, 'score' => 72, 'remaining_after' => 60],
                        ['player' => 'Boye Buckingham', 'visit_number' => 4, 'score' => 60, 'remaining_after' => 196],
                        ['player' => 'Andre Kendrick', 'visit_number' => 5, 'score' => 60, 'remaining_after' => 0],
                    ],
                ],
                [
                    'leg_number' => 2,
                    'starting_player' => 'Boye Buckingham',
                    'winner' => 'Andre Kendrick',
                    'status' => 'completed',
                    'finished_at' => date('Y-m-d 18:23:00'),
                    'visits' => [
                        ['player' => 'Boye Buckingham', 'visit_number' => 1, 'score' => 100, 'remaining_after' => 401],
                        ['player' => 'Andre Kendrick', 'visit_number' => 1, 'score' => 140, 'remaining_after' => 361],
                        ['player' => 'Boye Buckingham', 'visit_number' => 2, 'score' => 95, 'remaining_after' => 306],
                        ['player' => 'Andre Kendrick', 'visit_number' => 2, 'score' => 140, 'remaining_after' => 221],
                        ['player' => 'Boye Buckingham', 'visit_number' => 3, 'score' => 60, 'remaining_after' => 246],
                        ['player' => 'Andre Kendrick', 'visit_number' => 3, 'score' => 100, 'remaining_after' => 121],
                        ['player' => 'Boye Buckingham', 'visit_number' => 4, 'score' => 81, 'remaining_after' => 165],
                        ['player' => 'Andre Kendrick', 'visit_number' => 4, 'score' => 81, 'remaining_after' => 40],
                        ['player' => 'Boye Buckingham', 'visit_number' => 5, 'score' => 45, 'remaining_after' => 120],
                        ['player' => 'Andre Kendrick', 'visit_number' => 5, 'score' => 40, 'remaining_after' => 0],
                    ],
                ],
            ],
        ],
        [
            'match' => 'Rankingkamp 2',
            'legs' => [
                [
                    'leg_number' => 1,
                    'starting_player' => 'Thomas Kildal',
                    'winner' => 'Thomas Kildal',
                    'status' => 'completed',
                    'finished_at' => date('Y-m-d 18:39:00'),
                    'visits' => [
                        ['player' => 'Thomas Kildal', 'visit_number' => 1, 'score' => 100, 'remaining_after' => 401],
                        ['player' => 'Vetle Ribe Davidsen', 'visit_number' => 1, 'score' => 60, 'remaining_after' => 441],
                        ['player' => 'Thomas Kildal', 'visit_number' => 2, 'score' => 135, 'remaining_after' => 266],
                        ['player' => 'Vetle Ribe Davidsen', 'visit_number' => 2, 'score' => 100, 'remaining_after' => 341],
                        ['player' => 'Thomas Kildal', 'visit_number' => 3, 'score' => 96, 'remaining_after' => 170],
                        ['player' => 'Vetle Ribe Davidsen', 'visit_number' => 3, 'score' => 81, 'remaining_after' => 260],
                        ['player' => 'Thomas Kildal', 'visit_number' => 4, 'score' => 170, 'remaining_after' => 0],
                    ],
                ],
            ],
        ],
        [
            'match' => 'Rankingkamp 3',
            'legs' => [
                [
                    'leg_number' => 1,
                    'starting_player' => 'Andre Hammer',
                    'winner' => 'Andre Hammer',
                    'status' => 'completed',
                    'finished_at' => date('Y-m-d 19:03:00'),
                    'visits' => [
                        ['player' => 'Andre Hammer', 'visit_number' => 1, 'score' => 140, 'remaining_after' => 361],
                        ['player' => 'Geir Atle Håland', 'visit_number' => 1, 'score' => 85, 'remaining_after' => 416],
                        ['player' => 'Andre Hammer', 'visit_number' => 2, 'score' => 140, 'remaining_after' => 221],
                        ['player' => 'Geir Atle Håland', 'visit_number' => 2, 'score' => 100, 'remaining_after' => 316],
                        ['player' => 'Andre Hammer', 'visit_number' => 3, 'score' => 81, 'remaining_after' => 140],
                        ['player' => 'Geir Atle Håland', 'visit_number' => 3, 'score' => 60, 'remaining_after' => 256],
                        ['player' => 'Andre Hammer', 'visit_number' => 4, 'score' => 140, 'remaining_after' => 0],
                    ],
                ],
            ],
        ],
    ];

    foreach ($liveVisits as $matchSeed) {
        $matchId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}matches` WHERE tournament_id = ? AND round_label = ? LIMIT 1",
            'is',
            [$tournamentId, $matchSeed['match']]
        );

        if ($matchId === null) {
            continue;
        }

        clear_match_runtime($mysqli, $prefix, $matchId);

        foreach ($matchSeed['legs'] as $legSeed) {
            $startingPlayerId = $players[$legSeed['starting_player']] ?? null;
            $winnerId = isset($legSeed['winner']) && $legSeed['winner'] !== null ? ($players[$legSeed['winner']] ?? null) : null;

            if ($startingPlayerId === null) {
                continue;
            }

            $insertLeg = $mysqli->prepare(
                "INSERT INTO `{$prefix}legs`
                 (match_id, leg_number, starting_player_id, winner_player_id, status, start_score, finished_at)
                 VALUES (?, ?, ?, ?, ?, 501, ?)"
            );
            $insertLeg->bind_param(
                'iiiiss',
                $matchId,
                $legSeed['leg_number'],
                $startingPlayerId,
                $winnerId,
                $legSeed['status'],
                $legSeed['finished_at'] ?? null
            );
            $insertLeg->execute();
            $legId = (int) $insertLeg->insert_id;
            $insertLeg->close();

            foreach ($legSeed['visits'] as $visitSeed) {
                $playerId = $players[$visitSeed['player']] ?? null;

                if ($playerId === null) {
                    continue;
                }

                $inputMode = 'sum';
                $dartsJson = null;
                $isBust = 0;
                $dartsUsed = 3;
                $insertVisit = $mysqli->prepare(
                    "INSERT INTO `{$prefix}visits`
                     (match_id, leg_id, player_id, visit_number, score, darts_used, input_mode, darts_json, is_bust, remaining_after)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                );
                $insertVisit->bind_param(
                    'iiiiiissii',
                    $matchId,
                    $legId,
                    $playerId,
                    $visitSeed['visit_number'],
                    $visitSeed['score'],
                    $dartsUsed,
                    $inputMode,
                    $dartsJson,
                    $isBust,
                    $visitSeed['remaining_after']
                );
                $insertVisit->execute();
                $insertVisit->close();
            }
        }
    }

    $rankings = [
        ['player' => 'Andre Kendrick', 'type' => 'elo', 'points' => 1544.00, 'position' => 1],
        ['player' => 'Bjørn Jarle Jahnsen', 'type' => 'elo', 'points' => 1531.00, 'position' => 2],
        ['player' => 'Andre Hammer', 'type' => 'elo', 'points' => 1518.00, 'position' => 3],
        ['player' => 'Thomas Kildal', 'type' => 'elo', 'points' => 1509.00, 'position' => 4],
        ['player' => 'Andreas Tingstveit Hansen', 'type' => 'elo', 'points' => 1504.00, 'position' => 5],
        ['player' => 'Andre Kendrick', 'type' => 'order_of_merit', 'points' => 43.00, 'position' => 1],
        ['player' => 'Bjørn Jarle Jahnsen', 'type' => 'order_of_merit', 'points' => 37.00, 'position' => 2],
        ['player' => 'Andreas Tingstveit Hansen', 'type' => 'order_of_merit', 'points' => 35.00, 'position' => 3],
        ['player' => 'Thomas Kildal', 'type' => 'order_of_merit', 'points' => 33.00, 'position' => 4],
        ['player' => 'Andre Hammer', 'type' => 'order_of_merit', 'points' => 31.00, 'position' => 5],
    ];

    foreach ($rankings as $ranking) {
        $playerId = $players[$ranking['player']] ?? null;

        if ($playerId === null || $seasonId === null) {
            continue;
        }

        $existingId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}ranking_snapshots`
             WHERE season_id = ? AND player_id = ? AND ranking_type = ? AND scope_type = 'season'
             ORDER BY id DESC
             LIMIT 1",
            'iis',
            [$seasonId, $playerId, $ranking['type']]
        );

        $contextJson = json_encode(['source' => 'screen-demo'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($existingId === null) {
            $scopeType = 'season';
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
            continue;
        }

        $updateRanking = $mysqli->prepare(
            "UPDATE `{$prefix}ranking_snapshots`
             SET points = ?, position = ?, context_json = ?, calculated_at = NOW()
             WHERE id = ?"
        );
        $updateRanking->bind_param('disi', $ranking['points'], $ranking['position'], $contextJson, $existingId);
        $updateRanking->execute();
        $updateRanking->close();
    }
};

/**
 * @param array<int, string> $names
 * @return array<string, int>
 */
function load_players_by_name(mysqli $mysqli, string $prefix, array $names): array
{
    $players = [];

    foreach ($names as $name) {
        $playerId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}players` WHERE display_name = ? LIMIT 1",
            's',
            [$name]
        );

        if ($playerId !== null) {
            $players[$name] = $playerId;
        }
    }

    return $players;
}

/**
 * @param array<int, string> $codes
 * @return array<string, int>
 */
function load_kiosks_by_code(mysqli $mysqli, string $prefix, array $codes): array
{
    $kiosks = [];

    foreach ($codes as $code) {
        $kioskId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}kiosks` WHERE code = ? LIMIT 1",
            's',
            [$code]
        );

        if ($kioskId !== null) {
            $kiosks[$code] = $kioskId;
        }
    }

    return $kiosks;
}

function clear_match_runtime(mysqli $mysqli, string $prefix, int $matchId): void
{
    $deleteVisits = $mysqli->prepare("DELETE FROM `{$prefix}visits` WHERE match_id = ?");
    $deleteVisits->bind_param('i', $matchId);
    $deleteVisits->execute();
    $deleteVisits->close();

    $deleteLegs = $mysqli->prepare("DELETE FROM `{$prefix}legs` WHERE match_id = ?");
    $deleteLegs->bind_param('i', $matchId);
    $deleteLegs->execute();
    $deleteLegs->close();
}

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
