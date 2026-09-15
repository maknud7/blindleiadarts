ALTER TABLE `{{TABLE_PREFIX}}matches`
    ADD KEY `idx_matches_kiosk_status_id` (`kiosk_id`, `status`, `id`);
