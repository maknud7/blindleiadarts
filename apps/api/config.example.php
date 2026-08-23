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
    'dartsatlas' => [
        'season_id' => 'rFByCgOqI1rq',
        'tournament_id' => '',
        'club_id' => 1,
        'local_season_id' => null,
        'members_table' => 'medlemmer',
        'poll_interval_seconds' => 30,
        'user_agent' => 'BlindleiaDarts/1.0',
    ],
];
