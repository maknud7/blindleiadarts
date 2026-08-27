<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    // This one-time cleanup is deliberately TEST-only. Production merges go
    // through the audited admin workflow added in 0054.
    if ($prefix !== 'bd_test_') {
        return;
    }

    $players = $prefix . 'players';
    $tournamentPlayers = $prefix . 'tournament_players';
    $matches = $prefix . 'matches';
    $elo = $prefix . 'elo_current_ratings';
    $ranking = $prefix . 'season_ranking_events';
    $playoffEntries = $prefix . 'tournament_playoff_entries';
    $external = $prefix . 'external_references';
    $merges = $prefix . 'player_identity_merges';

    $tableExists = static function (mysqli $db, string $table): bool {
        $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    $pairConflict = static function (mysqli $db, string $table, string $scopeColumn, string $playerColumn, int $source, int $target) use ($tableExists): bool {
        if (!$tableExists($db, $table)) return false;
        $stmt = $db->prepare(
            "SELECT 1 FROM `{$table}` a INNER JOIN `{$table}` b ON b.`{$scopeColumn}`=a.`{$scopeColumn}` WHERE a.`{$playerColumn}`=? AND b.`{$playerColumn}`=? LIMIT 1"
        );
        $stmt->bind_param('ii', $source, $target);
        $stmt->execute();
        $conflict = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $conflict;
    };

    $references = [];
    $stmt = $mysqli->prepare(
        'SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE()
           AND REFERENCED_TABLE_NAME=? AND REFERENCED_COLUMN_NAME="id"
         ORDER BY TABLE_NAME,COLUMN_NAME'
    );
    $stmt->bind_param('s', $players);
    $stmt->execute();
    foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
        $references[] = ['table' => (string) $row['TABLE_NAME'], 'column' => (string) $row['COLUMN_NAME']];
    }
    $stmt->close();

    $duplicateGroups = $mysqli->query(
        "SELECT club_id,LOWER(TRIM(display_name)) AS normalized_name
         FROM `{$players}`
         WHERE club_id IS NOT NULL AND merged_into_player_id IS NULL
         GROUP BY club_id,LOWER(TRIM(display_name))
         HAVING COUNT(*)>1"
    )->fetch_all(MYSQLI_ASSOC);

    foreach ($duplicateGroups as $group) {
        $clubId = (int) $group['club_id'];
        $normalizedName = (string) $group['normalized_name'];
        $stmt = $mysqli->prepare(
            "SELECT p.*,
                    (SELECT COUNT(*) FROM `{$matches}` m WHERE m.player_a_id=p.id OR m.player_b_id=p.id) AS match_count,
                    (SELECT COUNT(*) FROM `{$tournamentPlayers}` tp WHERE tp.player_id=p.id) AS tournament_count
             FROM `{$players}` p
             WHERE p.club_id=? AND LOWER(TRIM(p.display_name))=? AND p.merged_into_player_id IS NULL
             ORDER BY (p.member_id IS NOT NULL) DESC,p.is_active DESC,match_count DESC,tournament_count DESC,p.id ASC"
        );
        $stmt->bind_param('is', $clubId, $normalizedName);
        $stmt->execute();
        $groupPlayers = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        if (count($groupPlayers) < 2) continue;

        $target = array_shift($groupPlayers);
        $targetId = (int) $target['id'];

        foreach ($groupPlayers as $source) {
            $sourceId = (int) $source['id'];
            if ($sourceId === $targetId) continue;

            if ($source['member_id'] !== null && $target['member_id'] !== null && (int) $source['member_id'] !== (int) $target['member_id']) {
                continue;
            }
            if ($pairConflict($mysqli, $tournamentPlayers, 'tournament_id', 'player_id', $sourceId, $targetId)) continue;
            if ($pairConflict($mysqli, $elo, 'season_id', 'player_id', $sourceId, $targetId)) continue;
            if ($pairConflict($mysqli, $playoffEntries, 'playoff_id', 'player_id', $sourceId, $targetId)) continue;

            if ($tableExists($mysqli, $ranking)) {
                $stmt = $mysqli->prepare(
                    "SELECT 1 FROM `{$ranking}` a INNER JOIN `{$ranking}` b ON b.tournament_id=a.tournament_id AND b.ruleset=a.ruleset WHERE a.player_id=? AND b.player_id=? LIMIT 1"
                );
                $stmt->bind_param('ii', $sourceId, $targetId);
                $stmt->execute();
                $rankingConflict = $stmt->get_result()->fetch_assoc() !== null;
                $stmt->close();
                if ($rankingConflict) continue;
            }

            $stmt = $mysqli->prepare(
                "SELECT 1 FROM `{$matches}` WHERE (player_a_id=? AND player_b_id=?) OR (player_a_id=? AND player_b_id=?) LIMIT 1"
            );
            $stmt->bind_param('iiii', $sourceId, $targetId, $targetId, $sourceId);
            $stmt->execute();
            $selfMatchConflict = $stmt->get_result()->fetch_assoc() !== null;
            $stmt->close();
            if ($selfMatchConflict) continue;

            $mysqli->begin_transaction();
            try {
                $stmt = $mysqli->prepare(
                    "UPDATE `{$players}` t INNER JOIN `{$players}` s ON s.id=?
                     SET t.first_name=COALESCE(t.first_name,s.first_name),
                         t.last_name=COALESCE(t.last_name,s.last_name),
                         t.nickname=COALESCE(t.nickname,s.nickname),
                         t.avatar_url=COALESCE(t.avatar_url,s.avatar_url),
                         t.member_id=COALESCE(t.member_id,s.member_id),
                         t.member_link_source=COALESCE(t.member_link_source,s.member_link_source),
                         t.member_linked_at=COALESCE(t.member_linked_at,s.member_linked_at),
                         t.is_active=1
                     WHERE t.id=?"
                );
                $stmt->bind_param('ii', $sourceId, $targetId);
                $stmt->execute();
                $stmt->close();

                $moved = [];
                foreach ($references as $reference) {
                    $table = $reference['table'];
                    $column = $reference['column'];
                    if ($table === $players && $column === 'merged_into_player_id') continue;
                    $stmt = $mysqli->prepare("UPDATE `{$table}` SET `{$column}`=? WHERE `{$column}`=?");
                    $stmt->bind_param('ii', $targetId, $sourceId);
                    $stmt->execute();
                    if ($stmt->affected_rows > 0) $moved[$table . '.' . $column] = $stmt->affected_rows;
                    $stmt->close();
                }

                if ($tableExists($mysqli, $external)) {
                    $stmt = $mysqli->prepare(
                        "UPDATE `{$external}` SET internal_id=? WHERE internal_id=? AND internal_entity_type IN ('player','players')"
                    );
                    $stmt->bind_param('ii', $targetId, $sourceId);
                    $stmt->execute();
                    if ($stmt->affected_rows > 0) $moved['external_references.internal_id'] = $stmt->affected_rows;
                    $stmt->close();
                }

                $stmt = $mysqli->prepare("UPDATE `{$players}` SET is_active=0,merged_into_player_id=?,merged_at=NOW() WHERE id=? AND merged_into_player_id IS NULL");
                $stmt->bind_param('ii', $targetId, $sourceId);
                $stmt->execute();
                if ($stmt->affected_rows !== 1) throw new RuntimeException('Could not mark duplicate player as merged.');
                $stmt->close();

                $summary = json_encode(['automatic_test_cleanup' => true, 'moved' => $moved], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $sourceName = (string) $source['display_name'];
                $targetName = (string) $target['display_name'];
                $reason = 'Safe exact-name TEST cleanup during Phase 1';
                $stmt = $mysqli->prepare(
                    "INSERT INTO `{$merges}` (club_id,source_player_id,target_player_id,source_display_name,target_display_name,merged_by_user_account_id,reason,summary_json)
                     VALUES (?,?,?,?,?,NULL,?,?)"
                );
                $stmt->bind_param('iiissss', $clubId, $sourceId, $targetId, $sourceName, $targetName, $reason, $summary);
                $stmt->execute();
                $stmt->close();

                $mysqli->commit();
                // The target may have gained member/profile data; use the refreshed
                // row as the basis for subsequent duplicates in the same name group.
                $refresh = $mysqli->prepare("SELECT * FROM `{$players}` WHERE id=? LIMIT 1");
                $refresh->bind_param('i', $targetId);
                $refresh->execute();
                $target = $refresh->get_result()->fetch_assoc() ?: $target;
                $refresh->close();
            } catch (Throwable $error) {
                $mysqli->rollback();
                // A unique constraint not covered by the pre-flight checks means
                // this candidate is not safe. Leave it untouched for admin review.
                continue;
            }
        }
    }
};
