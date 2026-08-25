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
    'scolia' => [
        // Shared secret used only between apps/scolia-bridge and the internal PHP API.
        // The Scolia service-account access token itself is configured in Admin per club.
        'bridge_secret' => 'replace-with-a-long-random-secret',
    ],
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'dart_database_name',
        'username' => 'dart_database_user',
        'password' => 'dart_database_password',
        // Tournament/scoring/runtime data stays environment-specific.
        'table_prefix' => 'bd_test_',
        // Accounts, sessions and permissions are shared with production in the
        // deployed test environment. CI can omit/override this to remain isolated.
        'identity_table_prefix' => 'bd_prod_',
    ],
    'members_db' => [
        // The member registry is shared for test and production and uses the same
        // physical source as Blindleia admin. There is no copied test member base.
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