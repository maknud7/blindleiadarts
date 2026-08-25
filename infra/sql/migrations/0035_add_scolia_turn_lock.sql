ALTER TABLE `{{TABLE_PREFIX}}scolia_board_runtime`
    ADD COLUMN `turn_locked_until_takeout` TINYINT(1) NOT NULL DEFAULT 0
    AFTER `needs_reconciliation`;
