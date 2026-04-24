<?php

declare(strict_types=1);

return static function (\mysqli $mysqli, string $prefix): void {
    $tournamentSlug = 'blindleia-test-cup';

    $tournamentId = fetch_seed_tournament_id($mysqli, $prefix, $tournamentSlug);

    if ($tournamentId === null) {
        return;
    }

    $kioskSql = sprintf(
        'SELECT id
         FROM `%1$skiosks`
         WHERE club_id = (
            SELECT club_id FROM `%1$stournaments` WHERE id = ?
         )
         ORDER BY board_number ASC, id ASC',
        $prefix
    );

    $statement = $mysqli->prepare($kioskSql);
    $statement->bind_param('i', $tournamentId);
    $statement->execute();
    $result = $statement->get_result();
    /** @var array<int, array<string, mixed>> $rows */
    $rows = $result->fetch_all(MYSQLI_ASSOC);
    $statement->close();

    $deleteSql = sprintf('DELETE FROM `%1$stournament_kiosks` WHERE tournament_id = ?', $prefix);
    $delete = $mysqli->prepare($deleteSql);
    $delete->bind_param('i', $tournamentId);
    $delete->execute();
    $delete->close();

    $insertSql = sprintf(
        'INSERT INTO `%1$stournament_kiosks` (tournament_id, kiosk_id, sort_order)
         VALUES (?, ?, ?)',
        $prefix
    );
    $insert = $mysqli->prepare($insertSql);

    $sortOrder = 1;
    foreach ($rows as $row) {
        $kioskId = (int) ($row['id'] ?? 0);

        if ($kioskId <= 0) {
            continue;
        }

        $insert->bind_param('iii', $tournamentId, $kioskId, $sortOrder);
        $insert->execute();
        $sortOrder++;
    }

    $insert->close();
};

function fetch_seed_tournament_id(\mysqli $mysqli, string $prefix, string $slug): ?int
{
    $sql = sprintf('SELECT id FROM `%1$stournaments` WHERE slug = ? LIMIT 1', $prefix);
    $statement = $mysqli->prepare($sql);
    $statement->bind_param('s', $slug);
    $statement->execute();
    $result = $statement->get_result();
    $row = $result->fetch_assoc() ?: null;
    $statement->close();

    return $row !== null ? (int) $row['id'] : null;
}
