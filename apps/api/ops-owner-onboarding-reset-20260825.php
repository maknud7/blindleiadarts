<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
http_response_code(404);
echo json_encode([
    'ok' => false,
    'error' => [
        'code' => 'not_found',
        'message' => 'Ikke tilgjengelig.',
    ],
], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
