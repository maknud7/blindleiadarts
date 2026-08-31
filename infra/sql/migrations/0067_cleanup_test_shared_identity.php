<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    // TEST has its own tournament/scoring actors, but authentication and membership
    // are canonical in PROD. Keep historical TEST player rows, while removing the
    // obsolete TEST auth shadow and canonicalising member-linked TEST players.
    if ($prefix !== 'bd_test_') {
        return;
    }

    $identityPrefix = trim((string) (getenv('IDENTITY_TABLE_PREFIX') ?: 'bd_prod_'));
    if (!preg_match('/^[A-Za-z0-9_]+$/', $identityPrefix) || $identityPrefix === $prefix) {
        throw new RuntimeException('TEST identity cleanup requires a separate canonical identity prefix.');
    }

    $localPlayers = $prefix . 'players';
    $localClubs = $prefix . 'clubs';
    $localUsers = $prefix . 'user_accounts';
    $localTournamentPlayers = $prefix . 'tournament_players';
    $localTournaments = $prefix . 'tournaments';
    $localMerges = $prefix . 'player_identity_merges';

    $identityPlayers = $identityPrefix . 'players';
    $identityClubs = $identityPrefix . 'clubs';
    $identityUsers = $identityPrefix . 'user_accounts';

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

    $columnExists = static function (mysqli $db, string $table, string $column): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $column);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    $countRows = static function (mysqli $db, string $table): int {
        return (int) ($db->query("SELECT COUNT(*) AS c FROM `{$table}`")->fetch_assoc()['c'] ?? 0);
    };

    foreach ([$localPlayers, $localClubs, $localUsers, $localTournamentPlayers, $localTournaments, $identityPlayers, $identityClubs, $identityUsers] as $table) {
        if (!$tableExists($mysqli, $table)) {
            throw new RuntimeException('Missing shared-identity cleanup dependency: ' . $table);
        }
    }

    foreach (['member_id', 'member_link_source', 'member_linked_at', 'merged_into_player_id', 'merged_at'] as $column) {
        if (!$columnExists($mysqli, $localPlayers, $column)) {
            throw new RuntimeException('TEST player identity column is missing: ' . $column);
        }
    }

    // 1) Remove the obsolete TEST-local authentication shadow. The deployment uses
    // bd_prod_ for sessions, users and permissions, so these rows are never canonical.
    $localUsersBefore = $countRows($mysqli, $localUsers);
    $allowedIdentityChildren = [
        $prefix . 'auth_sessions',
        $prefix . 'club_user_roles',
        $prefix . 'global_user_roles',
        $prefix . 'user_onboarding_invitations',
        $prefix . 'password_reset_tokens',
    ];

    $fk = $mysqli->prepare(
        'SELECT DISTINCT TABLE_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE CONSTRAINT_SCHEMA=DATABASE()
            AND REFERENCED_TABLE_SCHEMA=DATABASE()
            AND REFERENCED_TABLE_NAME=?'
    );
    $fk->bind_param('s', $localUsers);
    $fk->execute();
    $referencingTables = $fk->get_result()->fetch_all(MYSQLI_ASSOC);
    $fk->close();

    foreach ($referencingTables as $row) {
        $table = (string) ($row['TABLE_NAME'] ?? '');
        if ($table === '' || !in_array($table, $allowedIdentityChildren, true)) {
            throw new RuntimeException('Refusing TEST auth cleanup because a domain table still references local users: ' . $table);
        }
        $mysqli->query("DELETE FROM `{$table}`");
    }
    $mysqli->query("DELETE FROM `{$localUsers}`");

    // 2) Ensure every active PROD account with a canonical member-linked player has
    // one TEST player actor for the corresponding club. Existing TEST actors are reused.
    $insertSql = "INSERT INTO `{$localPlayers}`
        (club_id, display_name, first_name, last_name, nickname, avatar_url, is_active, member_id, member_link_source, member_linked_at)
        SELECT
            lc.id,
            ip.display_name,
            ip.first_name,
            ip.last_name,
            ip.nickname,
            ip.avatar_url,
            1,
            ip.member_id,
            'prod_identity',
            NOW()
        FROM `{$identityPlayers}` ip
        INNER JOIN `{$identityClubs}` ic ON ic.id=ip.club_id
        INNER JOIN `{$localClubs}` lc ON lc.slug=ic.slug
        WHERE ip.member_id IS NOT NULL
          AND ip.is_active=1
          AND ip.merged_into_player_id IS NULL
          AND ip.id=(
              SELECT MIN(ip2.id)
              FROM `{$identityPlayers}` ip2
              WHERE ip2.club_id=ip.club_id
                AND ip2.member_id=ip.member_id
                AND ip2.is_active=1
                AND ip2.merged_into_player_id IS NULL
          )
          AND EXISTS (
              SELECT 1
              FROM `{$identityUsers}` ua
              LEFT JOIN `{$identityPlayers}` uap ON uap.id=ua.player_id
              WHERE ua.is_active=1
                AND ua.account_status='active'
                AND COALESCE(ua.member_id,uap.member_id)=ip.member_id
          )
          AND NOT EXISTS (
              SELECT 1 FROM `{$localPlayers}` lp
              WHERE lp.club_id=lc.id AND lp.member_id=ip.member_id
          )";
    $mysqli->query($insertSql);
    $insertedPlayers = $mysqli->affected_rows;

    // 3) Canonical PROD identity owns the current display/profile metadata for any
    // member-linked TEST actor. Historical match data remains environment-local.
    $updateSql = "UPDATE `{$localPlayers}` lp
        INNER JOIN `{$localClubs}` lc ON lc.id=lp.club_id
        INNER JOIN `{$identityClubs}` ic ON ic.slug=lc.slug
        INNER JOIN `{$identityPlayers}` ip ON ip.id=(
            SELECT MIN(ip2.id)
            FROM `{$identityPlayers}` ip2
            WHERE ip2.club_id=ic.id
              AND ip2.member_id=lp.member_id
              AND ip2.is_active=1
              AND ip2.merged_into_player_id IS NULL
        )
        SET lp.display_name=ip.display_name,
            lp.first_name=ip.first_name,
            lp.last_name=ip.last_name,
            lp.nickname=ip.nickname,
            lp.avatar_url=ip.avatar_url,
            lp.member_link_source='prod_identity',
            lp.member_linked_at=COALESCE(lp.member_linked_at,NOW())
        WHERE lp.member_id IS NOT NULL";
    $mysqli->query($updateSql);
    $canonicalisedProfiles = $mysqli->affected_rows;

    // 4) Collapse duplicate TEST actors that point to the same canonical member.
    // We do not rewrite historical matches/visits here. They remain auditable on the
    // old actor ID; the old actor is marked merged and removed from current selectors.
    // Draft/ready tournament registrations are safe to repoint to the canonical actor.
    $duplicateGroups = $mysqli->query(
        "SELECT club_id,member_id
         FROM `{$localPlayers}`
         WHERE member_id IS NOT NULL AND merged_into_player_id IS NULL
         GROUP BY club_id,member_id
         HAVING COUNT(*)>1"
    )->fetch_all(MYSQLI_ASSOC);

    $mergedPlayers = 0;
    $repointedRegistrations = 0;
    $dedupedRegistrations = 0;

    foreach ($duplicateGroups as $group) {
        $clubId = (int) $group['club_id'];
        $memberId = (int) $group['member_id'];

        $pick = $mysqli->prepare(
            "SELECT p.id,p.display_name,
                    (SELECT COUNT(*) FROM `{$localTournamentPlayers}` tp WHERE tp.player_id=p.id) AS registration_count
             FROM `{$localPlayers}` p
             WHERE p.club_id=? AND p.member_id=? AND p.merged_into_player_id IS NULL
             ORDER BY p.is_active DESC, registration_count DESC, p.id ASC"
        );
        $pick->bind_param('ii', $clubId, $memberId);
        $pick->execute();
        $rows = $pick->get_result()->fetch_all(MYSQLI_ASSOC);
        $pick->close();
        if (count($rows) < 2) {
            continue;
        }

        $target = array_shift($rows);
        $targetId = (int) $target['id'];
        $targetName = (string) $target['display_name'];
        $mysqli->query("UPDATE `{$localPlayers}` SET is_active=1 WHERE id={$targetId}");

        foreach ($rows as $source) {
            $sourceId = (int) $source['id'];
            $sourceName = (string) $source['display_name'];
            if ($sourceId <= 0 || $sourceId === $targetId) {
                continue;
            }

            $mysqli->begin_transaction();
            try {
                $regs = $mysqli->prepare(
                    "SELECT tp.id,tp.tournament_id,tp.status,tp.seed
                     FROM `{$localTournamentPlayers}` tp
                     INNER JOIN `{$localTournaments}` t ON t.id=tp.tournament_id
                     WHERE tp.player_id=? AND t.status IN ('draft','ready')"
                );
                $regs->bind_param('i', $sourceId);
                $regs->execute();
                $sourceRegs = $regs->get_result()->fetch_all(MYSQLI_ASSOC);
                $regs->close();

                foreach ($sourceRegs as $registration) {
                    $registrationId = (int) $registration['id'];
                    $tournamentId = (int) $registration['tournament_id'];
                    $existing = $mysqli->prepare(
                        "SELECT id,status,seed FROM `{$localTournamentPlayers}` WHERE tournament_id=? AND player_id=? LIMIT 1"
                    );
                    $existing->bind_param('ii', $tournamentId, $targetId);
                    $existing->execute();
                    $targetRegistration = $existing->get_result()->fetch_assoc() ?: null;
                    $existing->close();

                    if ($targetRegistration === null) {
                        $move = $mysqli->prepare("UPDATE `{$localTournamentPlayers}` SET player_id=? WHERE id=?");
                        $move->bind_param('ii', $targetId, $registrationId);
                        $move->execute();
                        $repointedRegistrations += max(0, $move->affected_rows);
                        $move->close();
                        continue;
                    }

                    $rank = static fn (string $status): int => match ($status) {
                        'checked_in' => 6,
                        'registered' => 5,
                        'waitlisted' => 4,
                        'paused' => 3,
                        'no_show' => 2,
                        'eliminated' => 1,
                        default => 0,
                    };
                    $sourceStatus = (string) ($registration['status'] ?? 'registered');
                    $targetStatus = (string) ($targetRegistration['status'] ?? 'registered');
                    $bestStatus = $rank($sourceStatus) > $rank($targetStatus) ? $sourceStatus : $targetStatus;
                    $seed = $targetRegistration['seed'] ?? $registration['seed'] ?? null;
                    $targetRegistrationId = (int) $targetRegistration['id'];
                    $save = $mysqli->prepare("UPDATE `{$localTournamentPlayers}` SET status=?,seed=? WHERE id=?");
                    $save->bind_param('sii', $bestStatus, $seed, $targetRegistrationId);
                    $save->execute();
                    $save->close();

                    $delete = $mysqli->prepare("DELETE FROM `{$localTournamentPlayers}` WHERE id=?");
                    $delete->bind_param('i', $registrationId);
                    $delete->execute();
                    $dedupedRegistrations += max(0, $delete->affected_rows);
                    $delete->close();
                }

                $mark = $mysqli->prepare(
                    "UPDATE `{$localPlayers}`
                     SET is_active=0,merged_into_player_id=?,merged_at=COALESCE(merged_at,NOW())
                     WHERE id=? AND merged_into_player_id IS NULL"
                );
                $mark->bind_param('ii', $targetId, $sourceId);
                $mark->execute();
                if ($mark->affected_rows !== 1) {
                    throw new RuntimeException('Could not mark duplicate TEST player as merged.');
                }
                $mark->close();

                if ($tableExists($mysqli, $localMerges)) {
                    $summary = json_encode([
                        'automatic_test_shared_identity_cleanup' => true,
                        'member_id' => $memberId,
                        'historical_actor_references_preserved' => true,
                    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    $reason = 'Canonical PROD member identity for TEST player actor';
                    $audit = $mysqli->prepare(
                        "INSERT INTO `{$localMerges}`
                         (club_id,source_player_id,target_player_id,source_display_name,target_display_name,merged_by_user_account_id,reason,summary_json)
                         VALUES (?,?,?,?,?,NULL,?,?)"
                    );
                    $audit->bind_param('iiissss', $clubId, $sourceId, $targetId, $sourceName, $targetName, $reason, $summary);
                    $audit->execute();
                    $audit->close();
                }

                $mysqli->commit();
                $mergedPlayers++;
            } catch (Throwable $error) {
                $mysqli->rollback();
                throw $error;
            }
        }
    }

    // 5) Guardrails: no TEST-local users and no more than one selectable TEST actor
    // per canonical member. If this fails, stop deployment rather than hiding a bad state.
    $localUsersAfter = $countRows($mysqli, $localUsers);
    $duplicatesAfter = (int) ($mysqli->query(
        "SELECT COUNT(*) AS c FROM (
            SELECT club_id,member_id
            FROM `{$localPlayers}`
            WHERE member_id IS NOT NULL AND is_active=1 AND merged_into_player_id IS NULL
            GROUP BY club_id,member_id
            HAVING COUNT(*)>1
        ) d"
    )->fetch_assoc()['c'] ?? 0);

    if ($localUsersAfter !== 0) {
        throw new RuntimeException('TEST-local user_accounts remain after shared identity cleanup.');
    }
    if ($duplicatesAfter !== 0) {
        throw new RuntimeException('Duplicate selectable TEST players remain for the same canonical member.');
    }

    fwrite(STDOUT, sprintf(
        "TEST_SHARED_IDENTITY_CLEANUP users_removed=%d players_inserted=%d profiles_canonicalised=%d duplicate_players_merged=%d registrations_repointed=%d duplicate_registrations_removed=%d\n",
        $localUsersBefore,
        $insertedPlayers,
        $canonicalisedProfiles,
        $mergedPlayers,
        $repointedRegistrations,
        $dedupedRegistrations
    ));
};
