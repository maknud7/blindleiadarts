<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $table = $prefix . 'kiosks';

    $result = $mysqli->query("SELECT id, club_id, board_number FROM `{$table}` ORDER BY club_id ASC, board_number ASC, id ASC");
    $used = [];
    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    $result->free();

    foreach ($rows as $row) {
        $id = (int) $row['id'];
        $clubId = (int) $row['club_id'];
        $boardNumber = max(1, (int) $row['board_number']);
        $used[$clubId] ??= [];

        if (!isset($used[$clubId][$boardNumber])) {
            $used[$clubId][$boardNumber] = true;
            if ($boardNumber !== (int) $row['board_number']) {
                $update = $mysqli->prepare("UPDATE `{$table}` SET board_number = ? WHERE id = ?");
                $update->bind_param('ii', $boardNumber, $id);
                $update->execute();
                $update->close();
            }
            continue;
        }

        $candidate = 1;
        while (isset($used[$clubId][$candidate])) {
            $candidate++;
        }
        $used[$clubId][$candidate] = true;
        $update = $mysqli->prepare("UPDATE `{$table}` SET board_number = ? WHERE id = ?");
        $update->bind_param('ii', $candidate, $id);
        $update->execute();
        $update->close();
    }

    $index = 'uniq_kiosks_club_board_number';
    $check = $mysqli->prepare(
        'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1'
    );
    $check->bind_param('ss', $table, $index);
    $check->execute();
    $exists = $check->get_result()->fetch_assoc() !== null;
    $check->close();

    if (!$exists) {
        $mysqli->query("ALTER TABLE `{$table}` ADD UNIQUE KEY `{$index}` (`club_id`, `board_number`)");
    }
};
