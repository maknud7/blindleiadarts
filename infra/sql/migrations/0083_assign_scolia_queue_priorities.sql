-- Assign queue priority at the database boundary so every producer gets the same
-- policy, including bridge ingress, admin commands and future producers. Explicit
-- non-default priorities are preserved.

DROP TRIGGER IF EXISTS `{{TABLE_PREFIX}}scolia_events_priority_bi`;
CREATE TRIGGER `{{TABLE_PREFIX}}scolia_events_priority_bi`
BEFORE INSERT ON `{{TABLE_PREFIX}}scolia_events`
FOR EACH ROW
SET NEW.priority = CASE
    WHEN NEW.priority <> 50 THEN NEW.priority
    WHEN UPPER(NEW.event_type) = 'THROW_DETECTED' THEN 100
    WHEN UPPER(NEW.event_type) IN ('TAKEOUT_STARTED','TAKEOUT_FINISHED') THEN 95
    WHEN UPPER(NEW.event_type) IN ('BRIDGE_ERROR','BRIDGE_DISCONNECTED') THEN 90
    WHEN UPPER(NEW.event_type) = 'BRIDGE_CONNECTED' THEN 80
    WHEN UPPER(NEW.event_type) = 'HELLO_CLIENT' THEN 70
    WHEN UPPER(NEW.event_type) IN ('SBC_STATUS_CHANGED','SBC_BOARD_AVAILABILITY_CHANGED') THEN 40
    ELSE 50
END;

DROP TRIGGER IF EXISTS `{{TABLE_PREFIX}}scolia_commands_priority_bi`;
CREATE TRIGGER `{{TABLE_PREFIX}}scolia_commands_priority_bi`
BEFORE INSERT ON `{{TABLE_PREFIX}}scolia_commands`
FOR EACH ROW
SET NEW.priority = CASE
    WHEN NEW.priority <> 50 THEN NEW.priority
    WHEN UPPER(NEW.command_type) IN ('DELETE_THROW','THROW_CORRECTED') THEN 100
    WHEN UPPER(NEW.command_type) = 'RESET_PHASE' THEN 90
    ELSE 50
END;

-- Bring work already waiting at deploy time onto the same policy.
UPDATE `{{TABLE_PREFIX}}scolia_events`
SET priority = CASE
    WHEN UPPER(event_type) = 'THROW_DETECTED' THEN 100
    WHEN UPPER(event_type) IN ('TAKEOUT_STARTED','TAKEOUT_FINISHED') THEN 95
    WHEN UPPER(event_type) IN ('BRIDGE_ERROR','BRIDGE_DISCONNECTED') THEN 90
    WHEN UPPER(event_type) = 'BRIDGE_CONNECTED' THEN 80
    WHEN UPPER(event_type) = 'HELLO_CLIENT' THEN 70
    WHEN UPPER(event_type) IN ('SBC_STATUS_CHANGED','SBC_BOARD_AVAILABILITY_CHANGED') THEN 40
    ELSE priority
END
WHERE priority = 50 AND processing_status IN ('queued','failed');

UPDATE `{{TABLE_PREFIX}}scolia_commands`
SET priority = CASE
    WHEN UPPER(command_type) IN ('DELETE_THROW','THROW_CORRECTED') THEN 100
    WHEN UPPER(command_type) = 'RESET_PHASE' THEN 90
    ELSE priority
END
WHERE priority = 50 AND status IN ('queued','failed');
