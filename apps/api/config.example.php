<?php

return [
    'app_env' => 'test',
    'base_url' => 'https://example.test/blindleiadarts/test',
    'static_base_url' => 'https://example.test/blindleiadarts/test/static',
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'shared_database_name',
        'username' => 'database_user',
        'password' => 'database_password',
        'table_prefix' => 'bd_test_',
    ],

    // Existing Blindleia admin/member register in the same physical database.
    'member_table' => 'medlemmer',

    'dartsatlas' => [
        'base_url' => 'https://www.dartsatlas.com',

        // Set one tournament directly for the most predictable live polling.
        'tournament_id' => '',

        // Or discover tournament links from a Darts Atlas venue/season calendar.
        'source_url' => 'https://www.dartsatlas.com/venues/blindleia-dartklubb/tournaments/calendar',

        // Optional season reference for metadata.
        'season_id' => '',

        // Discovery is intentionally conservative so a live poll cannot fan out
        // into dozens of old tournaments.
        'max_tournaments_per_run' => 3,
    ],
];
