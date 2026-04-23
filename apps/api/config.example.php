<?php

return [
    'app_env' => 'test',
    'base_url' => 'https://example.test/blindleiadarts/test',
    'static_base_url' => 'https://example.test/blindleiadarts/test/static',
    'realtime' => [
        'websocket_url' => 'wss://realtime.example.test/ws',
        'publish_url' => 'https://realtime.example.test/publish',
        'publish_secret' => 'replace-me',
    ],
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'shared_database_name',
        'username' => 'database_user',
        'password' => 'database_password',
        'table_prefix' => 'bd_test_',
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
