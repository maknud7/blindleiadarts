<?php

declare(strict_types=1);

/**
 * TEST must not retain an independently editable copy of physical Scolia
 * masterdata. Canonical token/serial/settings live in HARDWARE_TABLE_PREFIX.
 *
 * The serial-less rows created by an active TEST lease are intentionally kept:
 * they are ephemeral runtime mode bindings, not hardware configuration.
 */
return static function (mysqli $db, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "Skipping TEST Scolia masterdata cleanup for non-test prefix: {$prefix}" . PHP_EOL);
        return;
    }

    $clubSettings = $prefix . 'scolia_club_settings';
    $boardSettings = $prefix . 'scolia_board_settings';

    $db->begin_transaction();
    try {
        $db->query(
            "UPDATE `{$clubSettings}`
             SET access_token=NULL, enabled=0, updated_by_user_id=NULL
             WHERE access_token IS NOT NULL OR enabled<>0"
        );

        $db->query(
            "DELETE FROM `{$boardSettings}`
             WHERE serial_number IS NOT NULL AND TRIM(serial_number)<>''"
        );
        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    fwrite(STDOUT, "Removed legacy TEST Scolia token/serial masterdata copies; canonical configuration remains in PROD hardware tables." . PHP_EOL);
};
