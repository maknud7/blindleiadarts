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
            throw new RuntimeException('Missing TEST Champion-label cleanup dependency: ' . $table);
        }
    }

    // 0068 only handled one specific Atlas import shape. Some older TEST actors
    // have the same erroneous presentation prefix without that exact metadata.
    // Treat "Champion " as DartsAtlas presentation chrome, not player identity.
    $sources = $mysqli->query(
        "SELECT id,club_id,display_name,member_id
         FROM `{$players}`
         WHERE is_active=1
           AND merged_into_player_id IS NULL
           AND LOWER(TRIM(display_name)) LIKE 'champion %'
         ORDER BY id"
    )->fetch_all(MYSQLI_ASSOC);

    $merged = 0;
    $renamed = 0;
    $skipped = 0;

    foreach ($sources as $source) {
        $sourceId = (int) ($source['id'] ?? 0);
        $clubId = (int) ($source['club_id'] ?? 0);
        $sourceName = trim((string) ($source['display_name'] ?? ''));
        $sourceMemberId = $source['member_id'] === null ? null : (int) $source['member_id'];
        $targetName = trim((string) (preg_replace('/^Champion\s+/iu', '', $sourceName) ?? $sourceName));

        if ($sourceId <= 0 || $clubId <= 0 || $targetName === '' || $targetName === $sourceName) {
            $skipped++;
            continue;
        }

        $targetStmt = $mysqli->prepare(
            "SELECT id,display_name,member_id
             FROM `{$players}`
             WHERE club_id=?
               AND LOWER(TRIM(display_name))=LOWER(TRIM(?))
               AND id<>?
               AND is_active=1
               AND merged_into_player_id IS NULL
             ORDER BY (member_id IS NULL) ASC,id ASC"
        );
        $targetStmt->bind_param('isi', $clubId, $targetName, $sourceId);
        $targetStmt->execute();
        $targets = $targetStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $targetStmt->close();

        $target = null;
        foreach ($targets as $candidate) {
            $candidateMemberId = $candidate['member_id'] === null ? null : (int) $candidate['member_id'];
            if ($sourceMemberId === null || $candidateMemberId === null || $sourceMemberId === $candidateMemberId) {
                $target = $candidate;
                break;
            }
        }

        // If there is no compatible canonical actor, normalize the actor in place
        // rather than deleting it. Historical references keep the same player id.
        if ($target === null) {
            $rename = $mysqli->prepare(
                "UPDATE `{$players}` SET display_name=? WHERE id=? AND is_active=1 AND merged_into_player_id IS NULL"
            );
            $rename->bind_param('si', $targetName, $sourceId);
            $rename->execute();
            $changed = $rename->affected_rows;
            $rename->close();
            if ($changed === 1) {
                $renamed++;
            } else {
                $skipped++;
            }
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
                throw new RuntimeException('Could not retire remaining Champion player artifact.');
            }
            $mark->close();

            $summary = json_encode([
                'automatic_test_import_label_cleanup' => true,
                'broadened_after_0068' => true,
                'historical_actor_references_preserved' => true,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $reason = 'DartsAtlas Champion presentation label stored as TEST player name';
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

    $remaining = (int) ($mysqli->query(
        "SELECT COUNT(*) AS c
         FROM `{$players}`
         WHERE is_active=1
           AND merged_into_player_id IS NULL
           AND LOWER(TRIM(display_name)) LIKE 'champion %'"
    )->fetch_assoc()['c'] ?? 0);

    if ($remaining !== 0) {
        throw new RuntimeException('Selectable TEST players with Champion labels remain after cleanup.');
    }

    fwrite(STDOUT, sprintf(
        "TEST_CHAMPION_PLAYER_LABEL_CLEANUP_V2 merged=%d renamed=%d skipped=%d remaining=%d\n",
        $merged,
        $renamed,
        $skipped,
        $remaining
    ));
};
