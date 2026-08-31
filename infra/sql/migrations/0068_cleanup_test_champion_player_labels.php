<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        return;
    }

    $players = $prefix . 'players';
    $merges = $prefix . 'player_identity_merges';

    $tableExists = static function (mysqli $db, string $table): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
        );
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    foreach ([$players, $merges] as $table) {
        if (!$tableExists($mysqli, $table)) {
            throw new RuntimeException('Missing TEST champion-label cleanup dependency: ' . $table);
        }
    }

    $sources = $mysqli->query(
        "SELECT id,club_id,display_name
         FROM `{$players}`
         WHERE is_active=1
           AND merged_into_player_id IS NULL
           AND member_id IS NULL
           AND member_link_source='dartsatlas_import'
           AND display_name LIKE 'Champion %'
         ORDER BY id"
    )->fetch_all(MYSQLI_ASSOC);

    $merged = 0;
    $skipped = 0;

    foreach ($sources as $source) {
        $sourceId = (int) $source['id'];
        $clubId = (int) $source['club_id'];
        $sourceName = trim((string) $source['display_name']);
        $targetName = trim((string) preg_replace('/^Champion\s+/iu', '', $sourceName));

        if ($sourceId <= 0 || $clubId <= 0 || $targetName === '' || $targetName === $sourceName) {
            $skipped++;
            continue;
        }

        $targetStmt = $mysqli->prepare(
            "SELECT id,display_name
             FROM `{$players}`
             WHERE club_id=?
               AND display_name=?
               AND is_active=1
               AND merged_into_player_id IS NULL
             ORDER BY (member_id IS NULL) ASC,id ASC
             LIMIT 1"
        );
        $targetStmt->bind_param('is', $clubId, $targetName);
        $targetStmt->execute();
        $target = $targetStmt->get_result()->fetch_assoc() ?: null;
        $targetStmt->close();

        if ($target === null || (int) $target['id'] === $sourceId) {
            $skipped++;
            continue;
        }

        $targetId = (int) $target['id'];
        $canonicalName = (string) $target['display_name'];

        $mysqli->begin_transaction();
        try {
            $mark = $mysqli->prepare(
                "UPDATE `{$players}`
                 SET is_active=0,merged_into_player_id=?,merged_at=COALESCE(merged_at,NOW())
                 WHERE id=? AND is_active=1 AND merged_into_player_id IS NULL"
            );
            $mark->bind_param('ii', $targetId, $sourceId);
            $mark->execute();
            if ($mark->affected_rows !== 1) {
                throw new RuntimeException('Could not retire imported Champion player label.');
            }
            $mark->close();

            $summary = json_encode([
                'automatic_test_import_label_cleanup' => true,
                'historical_actor_references_preserved' => true,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $reason = 'Historical import label accidentally stored as TEST player name';
            $audit = $mysqli->prepare(
                "INSERT INTO `{$merges}`
                 (club_id,source_player_id,target_player_id,source_display_name,target_display_name,merged_by_user_account_id,reason,summary_json)
                 VALUES (?,?,?,?,?,NULL,?,?)"
            );
            $audit->bind_param('iiissss', $clubId, $sourceId, $targetId, $sourceName, $canonicalName, $reason, $summary);
            $audit->execute();
            $audit->close();

            $mysqli->commit();
            $merged++;
        } catch (Throwable $error) {
            $mysqli->rollback();
            throw $error;
        }
    }

    fwrite(STDOUT, sprintf(
        "TEST_CHAMPION_PLAYER_LABEL_CLEANUP merged=%d skipped=%d\n",
        $merged,
        $skipped
    ));
};
