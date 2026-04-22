<?php

declare(strict_types=1);

use mysqli;

return static function (mysqli $mysqli, string $prefix): void {
    $clubId = fetch_single_id($mysqli, "SELECT id FROM `{$prefix}clubs` WHERE slug = ? LIMIT 1", 's', ['blindleia-dartklubb']);

    if ($clubId === null) {
        return;
    }

    $kiosks = [
        ['code' => 'BOARD-1', 'name' => 'Board 1', 'board_number' => 1, 'sponsor_label' => 'Sparebanken Norge'],
        ['code' => 'BOARD-2', 'name' => 'Board 2', 'board_number' => 2, 'sponsor_label' => 'MENY Lillesand'],
        ['code' => 'BOARD-3', 'name' => 'Board 3', 'board_number' => 3, 'sponsor_label' => 'Montér Lillesand'],
        ['code' => 'BOARD-4', 'name' => 'Board 4', 'board_number' => 4, 'sponsor_label' => 'Circle K E18 Lillesand'],
    ];

    foreach ($kiosks as $kiosk) {
        $kioskId = fetch_single_id(
            $mysqli,
            "SELECT id FROM `{$prefix}kiosks` WHERE code = ? LIMIT 1",
            's',
            [$kiosk['code']]
        );

        if ($kioskId === null) {
            $isActive = 1;
            $scoringMode = 'manual';
            $sponsorLogoUrl = null;
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
                $scoringMode,
                $isActive
            );
            $insertKiosk->execute();
            $insertKiosk->close();
            continue;
        }

        $sponsorLogoUrl = null;
        $updateKiosk = $mysqli->prepare(
            "UPDATE `{$prefix}kiosks`
             SET `name` = ?, `board_number` = ?, `sponsor_label` = ?, `sponsor_logo_url` = ?
             WHERE `id` = ?"
        );
        $updateKiosk->bind_param(
            'sissi',
            $kiosk['name'],
            $kiosk['board_number'],
            $kiosk['sponsor_label'],
            $sponsorLogoUrl,
            $kioskId
        );
        $updateKiosk->execute();
        $updateKiosk->close();
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
