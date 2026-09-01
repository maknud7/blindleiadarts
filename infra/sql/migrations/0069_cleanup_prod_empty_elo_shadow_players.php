<?php

declare(strict_types=1);

return static function (mysqli $db, string $prefix): void {
    if ($prefix !== 'bd_prod_') {
        return;
    }

    $players = $prefix . 'players';
    $merges = $prefix . 'player_identity_merges';
    $external = $prefix . 'external_references';

    // Frozen after the read-only 2026-09-01 PROD inventory. Every source is an
    // empty bootstrap shadow; every target is its established history identity.
    $pairs = [
        25 => 1,  26 => 21, 27 => 18, 28 => 7,
        29 => 4,  30 => 17, 31 => 12, 32 => 9,
        33 => 10, 34 => 3,  35 => 11, 36 => 2,
    ];

    $references = [];
    $stmt = $db->prepare(
        'SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE()
           AND REFERENCED_TABLE_NAME=? AND REFERENCED_COLUMN_NAME="id"
         ORDER BY TABLE_NAME,COLUMN_NAME'
    );
    $stmt->bind_param('s', $players);
    $stmt->execute();
    foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
        $references[] = [(string) $row['TABLE_NAME'], (string) $row['COLUMN_NAME']];
    }
    $stmt->close();
    if ($references === []) {
        throw new RuntimeException('Cannot prove empty PROD shadow players: no player foreign keys found.');
    }

    $retired = 0;
    $alreadyDone = 0;
    foreach ($pairs as $sourceId => $targetId) {
        $stmt = $db->prepare(
            "SELECT id,club_id,display_name,member_id,is_active,merged_into_player_id
             FROM `{$players}` WHERE id IN (?,?) ORDER BY id"
        );
        $stmt->bind_param('ii', $sourceId, $targetId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $byId = [];
        foreach ($rows as $row) $byId[(int) $row['id']] = $row;
        if (!isset($byId[$sourceId], $byId[$targetId])) {
            throw new RuntimeException("Frozen PROD player pair is missing: {$sourceId} -> {$targetId}");
        }
        $source = $byId[$sourceId];
        $target = $byId[$targetId];
        if ((int) $source['club_id'] !== (int) $target['club_id']
            || trim((string) $source['display_name']) !== trim((string) $target['display_name'])) {
            throw new RuntimeException("Frozen PROD player identity drift: {$sourceId} -> {$targetId}");
        }
        if ((int) $source['is_active'] === 0 && (int) ($source['merged_into_player_id'] ?? 0) === $targetId) {
            $alreadyDone++;
            continue;
        }
        if ((int) $source['is_active'] !== 1 || $source['merged_into_player_id'] !== null || $source['member_id'] !== null) {
            throw new RuntimeException("PROD shadow is no longer an empty active candidate: {$sourceId}");
        }
        if ((int) $target['is_active'] !== 1 || $target['merged_into_player_id'] !== null) {
            throw new RuntimeException("PROD canonical target is not active: {$targetId}");
        }

        foreach ($references as [$table, $column]) {
            if ($table === $players && $column === 'merged_into_player_id') continue;
            $count = $db->prepare("SELECT COUNT(*) c FROM `{$table}` WHERE `{$column}`=?");
            $count->bind_param('i', $sourceId);
            $count->execute();
            $referencesFound = (int) ($count->get_result()->fetch_assoc()['c'] ?? 0);
            $count->close();
            if ($referencesFound !== 0) {
                throw new RuntimeException("PROD shadow {$sourceId} has {$referencesFound} reference(s) in {$table}.{$column}");
            }
        }

        $externalCount = $db->prepare(
            "SELECT COUNT(*) c FROM `{$external}`
             WHERE internal_entity_type IN ('player','players') AND internal_id=?"
        );
        $externalCount->bind_param('i', $sourceId);
        $externalCount->execute();
        $externalReferences = (int) ($externalCount->get_result()->fetch_assoc()['c'] ?? 0);
        $externalCount->close();
        if ($externalReferences !== 0) {
            throw new RuntimeException("PROD shadow {$sourceId} has external references.");
        }

        $db->begin_transaction();
        try {
            $mark = $db->prepare(
                "UPDATE `{$players}`
                 SET is_active=0,merged_into_player_id=?,merged_at=NOW()
                 WHERE id=? AND is_active=1 AND merged_into_player_id IS NULL AND member_id IS NULL"
            );
            $mark->bind_param('ii', $targetId, $sourceId);
            $mark->execute();
            if ($mark->affected_rows !== 1) {
                throw new RuntimeException("Could not retire frozen PROD shadow {$sourceId}");
            }
            $mark->close();

            $sourceName = (string) $source['display_name'];
            $targetName = (string) $target['display_name'];
            $reason = 'Remove empty PROD ELO shadow after canonical history promotion';
            $summary = json_encode([
                'frozen_prod_cleanup' => true,
                'all_foreign_key_references_verified_zero' => true,
                'external_references_verified_zero' => true,
                'historical_rows_moved' => 0,
            ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $audit = $db->prepare(
                "INSERT INTO `{$merges}`
                 (club_id,source_player_id,target_player_id,source_display_name,target_display_name,
                  merged_by_user_account_id,reason,summary_json)
                 VALUES (?,?,?,?,?,NULL,?,?)"
            );
            $clubId = (int) $source['club_id'];
            $audit->bind_param('iiissss', $clubId, $sourceId, $targetId, $sourceName, $targetName, $reason, $summary);
            $audit->execute();
            $audit->close();
            $db->commit();
            $retired++;
        } catch (Throwable $error) {
            $db->rollback();
            throw $error;
        }
    }

    $duplicates = (int) ($db->query(
        "SELECT COUNT(*) c FROM (
           SELECT club_id,LOWER(TRIM(display_name)) normalized_name
           FROM `{$players}`
           WHERE is_active=1 AND merged_into_player_id IS NULL
           GROUP BY club_id,LOWER(TRIM(display_name)) HAVING COUNT(*)>1
         ) duplicate_groups"
    )->fetch_assoc()['c'] ?? 0);
    if ($duplicates !== 0) {
        throw new RuntimeException("Active PROD player-name duplicates remain after cleanup: {$duplicates}");
    }

    fwrite(STDOUT, "PROD_EMPTY_ELO_SHADOW_CLEANUP_OK=yes retired={$retired} already_done={$alreadyDone}\n");
};
