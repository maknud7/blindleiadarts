ALTER TABLE `{{TABLE_PREFIX}}scolia_events`
    ADD KEY `idx_scolia_events_kiosk_fifo` (`kiosk_id`, `processing_status`, `id`, `next_attempt_at`);
