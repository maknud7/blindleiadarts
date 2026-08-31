<?php

declare(strict_types=1);

/**
 * One-time promotion of the already configured Blindleia Scolia service account
 * and physical Board 4 mapping from TEST into the canonical PROD hardware config.
 *
 * The access token is copied inside MySQL/PHP only and is never printed.
 */
return static function (mysqli $db, string $prefix): void {
    if ($prefix !== 'bd_prod_') {
        fwrite(STDOUT, "Skipping Scolia PROD promotion for non-production prefix: {$prefix}" . PHP_EOL);
        return;
    }

    $sourcePrefix = 'bd_test_';
    $targetPrefix = 'bd_prod_';
    $clubSlug = 'blindleia-dartklubb';
    $boardNumber = 4;

    foreach ([
        $sourcePrefix . 'clubs',
        $sourcePrefix . 'kiosks',
        $sourcePrefix . 'scolia_club_settings',
        $sourcePrefix . 'scolia_board_settings',
        $targetPrefix . 'clubs',
        $targetPrefix . 'kiosks',
        $targetPrefix . 'scolia_club_settings',
        $targetPrefix . 'scolia_board_settings',
        $targetPrefix . 'scolia_board_runtime',
    ] as $table) {
        $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        if (!$exists) {
            throw new RuntimeException("Required Scolia promotion table is missing: {$table}");
        }
    }

    $stmt = $db->prepare(
        "SELECT cs.enabled,cs.access_token,cs.force_connect,cs.forward_messages_to_scolia,
                cs.disconnect_fallback_enabled,cs.queue_max_attempts,cs.queue_retry_base_seconds,cs.event_retention_days
           FROM `{$sourcePrefix}scolia_club_settings` cs
           INNER JOIN `{$sourcePrefix}clubs` c ON c.id=cs.club_id
          WHERE c.slug=?
          LIMIT 1"
    );
    $stmt->bind_param('s', $clubSlug);
    $stmt->execute();
    $sourceClub = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();

    if ($sourceClub === null || (int) ($sourceClub['enabled'] ?? 0) !== 1 || trim((string) ($sourceClub['access_token'] ?? '')) === '') {
        throw new RuntimeException('TEST Scolia club configuration is missing, disabled, or has no access token.');
    }

    $stmt = $db->prepare("SELECT id FROM `{$targetPrefix}clubs` WHERE slug=? LIMIT 1");
    $stmt->bind_param('s', $clubSlug);
    $stmt->execute();
    $targetClubId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
    $stmt->close();
    if ($targetClubId <= 0) {
        throw new RuntimeException('Canonical PROD club was not found for Scolia promotion.');
    }

    $stmt = $db->prepare(
        "SELECT s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override
           FROM `{$sourcePrefix}scolia_board_settings` s
           INNER JOIN `{$sourcePrefix}kiosks` k ON k.id=s.kiosk_id
           INNER JOIN `{$sourcePrefix}clubs` c ON c.id=k.club_id
          WHERE c.slug=? AND k.board_number=? AND s.serial_number IS NOT NULL AND TRIM(s.serial_number)<>''
          ORDER BY s.updated_at DESC"
    );
    $stmt->bind_param('si', $clubSlug, $boardNumber);
    $stmt->execute();
    $result = $stmt->get_result();
    $sourceBoards = [];
    while ($row = $result->fetch_assoc()) {
        $sourceBoards[] = $row;
    }
    $stmt->close();

    $distinct = [];
    foreach ($sourceBoards as $row) {
        $serial = strtoupper(trim((string) ($row['serial_number'] ?? '')));
        if ($serial !== '') {
            $distinct[$serial] = $row;
        }
    }
    if (count($distinct) !== 1) {
        throw new RuntimeException('Expected exactly one configured Scolia serial for TEST Board 4.');
    }
    $sourceBoard = array_values($distinct)[0];
    if ((string) ($sourceBoard['mode'] ?? '') !== 'live') {
        throw new RuntimeException('TEST Board 4 Scolia mapping is not in live mode.');
    }

    $stmt = $db->prepare(
        "SELECT k.id
           FROM `{$targetPrefix}kiosks` k
           INNER JOIN `{$targetPrefix}clubs` c ON c.id=k.club_id
          WHERE c.slug=? AND k.board_number=? AND k.is_active=1
          ORDER BY k.id"
    );
    $stmt->bind_param('si', $clubSlug, $boardNumber);
    $stmt->execute();
    $targetRows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    if (count($targetRows) !== 1) {
        throw new RuntimeException('Expected exactly one active physical PROD Board 4.');
    }
    $targetKioskId = (int) $targetRows[0]['id'];

    $enabled = 1;
    $accessToken = (string) $sourceClub['access_token'];
    $forceConnect = (int) $sourceClub['force_connect'];
    $forwardMessages = (int) $sourceClub['forward_messages_to_scolia'];
    $disconnectFallback = (int) $sourceClub['disconnect_fallback_enabled'];
    $queueMaxAttempts = (int) $sourceClub['queue_max_attempts'];
    $queueRetryBase = (int) $sourceClub['queue_retry_base_seconds'];
    $eventRetention = (int) $sourceClub['event_retention_days'];

    $serial = strtoupper(trim((string) $sourceBoard['serial_number']));
    $autoFallback = (int) ($sourceBoard['auto_fallback_to_manual'] ?? 1);
    $forceOverride = $sourceBoard['force_connect_override'] === null ? null : (int) $sourceBoard['force_connect_override'];
    $forwardOverride = $sourceBoard['forward_messages_override'] === null ? null : (int) $sourceBoard['forward_messages_override'];

    $db->begin_transaction();
    try {
        $stmt = $db->prepare(
            "INSERT INTO `{$targetPrefix}scolia_club_settings`
                (club_id,enabled,access_token,force_connect,forward_messages_to_scolia,disconnect_fallback_enabled,
                 queue_max_attempts,queue_retry_base_seconds,event_retention_days,updated_by_user_id)
             VALUES (?,?,?,?,?,?,?,?,?,NULL)
             ON DUPLICATE KEY UPDATE
                enabled=VALUES(enabled),access_token=VALUES(access_token),force_connect=VALUES(force_connect),
                forward_messages_to_scolia=VALUES(forward_messages_to_scolia),
                disconnect_fallback_enabled=VALUES(disconnect_fallback_enabled),queue_max_attempts=VALUES(queue_max_attempts),
                queue_retry_base_seconds=VALUES(queue_retry_base_seconds),event_retention_days=VALUES(event_retention_days),
                updated_by_user_id=NULL"
        );
        $stmt->bind_param(
            'iisiiiiii',
            $targetClubId,
            $enabled,
            $accessToken,
            $forceConnect,
            $forwardMessages,
            $disconnectFallback,
            $queueMaxAttempts,
            $queueRetryBase,
            $eventRetention
        );
        $stmt->execute();
        $stmt->close();

        // Board serials must be globally unique inside PROD. Fail rather than silently
        // stealing an existing physical mapping from another board.
        $stmt = $db->prepare(
            "SELECT kiosk_id FROM `{$targetPrefix}scolia_board_settings` WHERE serial_number=? AND kiosk_id<>? LIMIT 1"
        );
        $stmt->bind_param('si', $serial, $targetKioskId);
        $stmt->execute();
        $conflict = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($conflict !== null) {
            throw new RuntimeException('The TEST Scolia serial is already mapped to another PROD board.');
        }

        $stmt = $db->prepare("UPDATE `{$targetPrefix}kiosks` SET scoring_mode='scolia' WHERE id=?");
        $stmt->bind_param('i', $targetKioskId);
        $stmt->execute();
        $stmt->close();

        $mode = 'live';
        $stmt = $db->prepare(
            "INSERT INTO `{$targetPrefix}scolia_board_settings`
                (kiosk_id,serial_number,mode,auto_fallback_to_manual,force_connect_override,forward_messages_override,updated_by_user_id)
             VALUES (?,?,?,?,?,?,NULL)
             ON DUPLICATE KEY UPDATE
                serial_number=VALUES(serial_number),mode=VALUES(mode),auto_fallback_to_manual=VALUES(auto_fallback_to_manual),
                force_connect_override=VALUES(force_connect_override),forward_messages_override=VALUES(forward_messages_override),
                updated_by_user_id=NULL"
        );
        $stmt->bind_param('issiii', $targetKioskId, $serial, $mode, $autoFallback, $forceOverride, $forwardOverride);
        $stmt->execute();
        $stmt->close();

        $stmt = $db->prepare(
            "INSERT INTO `{$targetPrefix}scolia_board_runtime` (kiosk_id,connection_state,fallback_active,needs_reconciliation)
             VALUES (?,'disconnected',0,0)
             ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=0,needs_reconciliation=0,
                 board_status=NULL,board_phase=NULL,error_type=NULL,last_disconnect_reason=NULL"
        );
        $stmt->bind_param('i', $targetKioskId);
        $stmt->execute();
        $stmt->close();

        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    fwrite(STDOUT, "Scolia PROD configuration promoted safely for physical Board 4; access token was not logged." . PHP_EOL);
};
