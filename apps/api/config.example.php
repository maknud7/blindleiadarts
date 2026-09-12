<?php

return [
    'app_env' => 'test',
    'base_url' => 'https://example.test/blindleiadarts/test',
    'identity_base_url' => 'https://blindleiadarts.ingenting.org',
    'static_base_url' => 'https://example.test/blindleiadarts/test/static',
    'screen' => [
        'default_club_slug' => 'blindleia-dartklubb',
    ],
    'realtime' => [
        'websocket_url' => 'wss://realtime.example.test/ws',
        'publish_url' => 'https://realtime.example.test/publish',
        'publish_secret' => 'replace-me',
    ],
    'scolia' => [
        'bridge_secret' => 'replace-with-a-long-random-secret',
    ],
    'backend_v2' => [
        // Safe defaults: each writer domain stays on PHP unless its independent
        // single-writer routing mode is explicitly enabled.
        'scoring_routing_mode' => 'php',
        'equipment_routing_mode' => 'php',
        'scolia_routing_mode' => 'php',
        'tournament_routing_mode' => 'php',
        'player_live_routing_mode' => 'php',
        'realtime_config_routing_mode' => 'php',
        'base_url' => '',
        'canary_kiosk_ids' => '',
        'internal_token' => '',
    ],
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'dart_database_name',
        'username' => 'dart_database_user',
        'password' => 'dart_database_password',
        'table_prefix' => 'bd_test_',
        'identity_table_prefix' => 'bd_prod_',
        'hardware_table_prefix' => 'bd_prod_',
        'max_concurrent_connections' => 0,
        'connection_wait_ms' => 3000,
    ],
    'members_db' => [
        'sqlconnect_path' => '/home/1/i/ingenting/dart/sqlconnect.php',
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