<?php

return [
    'app_env' => 'test',
    'base_url' => 'https://example.test/blindleiadarts/test',
    'static_base_url' => 'https://example.test/blindleiadarts/test/static',
    'screen' => [
        'default_club_slug' => 'blindleia-dartklubb',
    ],
    'realtime' => [
        'websocket_url' => 'wss://realtime.example.test/ws',
        'publish_url' => 'https://realtime.example.test/publish',
        'publish_secret' => 'replace-me',
    ],
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'dart_database_name',
        'username' => 'dart_database_user',
        'password' => 'dart_database_password',
        'table_prefix' => 'bd_test_',
    ],
    'members_db' => [
        // Preferred source on the server. Relative paths are resolved from apps/api.
        // In a deployed release ../sqlconnect.php means <release-root>/sqlconnect.php.
        // The file should create a mysqli connection in $conn, like the existing club admin.
        'sqlconnect_path' => '../sqlconnect.php',

        // Optional fallback only. DartsAtlas Live still works if both the local
        // sqlconnect.php and these credentials are unavailable; only automatic
        // player -> medlemmer.id linking is disabled.
        'host' => '',
        'port' => 3306,
        'database' => '',
        'username' => '',
        'password' => '',
    ],
    'dartsatlas' => [
        'season_id' => 'rFByCgOqI1rq',
        'tournament_id' => '',
        'club_id' => 1,
        'local_season_id' => null,
        'members_table' => 'medlemmer',
        'poll_interval_seconds' => 8,
        'user_agent' => 'BlindleiaDarts/1.0',
    ],
    'challonge' => [
        'api_base_url' => 'https://api.challonge.com/v2.1',
        'oauth_authorize_url' => 'https://api.challonge.com/oauth/authorize',
        'oauth_token_url' => 'https://api.challonge.com/oauth/token',
        'redirect_uri' => 'https://test.blindleiadarts.ingenting.org/api/v1/connectors/challonge/callback',
        'client_id' => '',
        'client_secret' => '',
        'default_scopes' => [
            'me',
            'tournaments:read',
            'participants:read',
            'matches:read',
        ],
    ],
];
