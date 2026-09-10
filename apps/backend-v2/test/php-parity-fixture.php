<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;

require __DIR__ . '/../../api/bootstrap.php';

$raw = stream_get_contents(STDIN);
$cases = json_decode($raw !== false ? $raw : '', true);
if (!is_array($cases)) {
    fwrite(STDERR, "Expected JSON array on stdin.\n");
    exit(2);
}

$rules = new Dart501Rules();
$results = [];

foreach ($cases as $case) {
    if (!is_array($case)) {
        $results[] = [
            'ok' => false,
            'error' => [
                'code' => 'fixture_invalid_case',
                'message' => 'Parity fixture case must be an object.',
                'status_code' => 500,
            ],
        ];
        continue;
    }

    try {
        $value = $rules->evaluateVisit(
            (int) ($case['remaining_before'] ?? 0),
            is_array($case['payload'] ?? null) ? $case['payload'] : []
        );
        $results[] = ['ok' => true, 'value' => $value];
    } catch (ValidationException $error) {
        $results[] = [
            'ok' => false,
            'error' => [
                'code' => $error->errorCode(),
                'message' => $error->getMessage(),
                'status_code' => $error->statusCode(),
            ],
        ];
    } catch (Throwable $error) {
        $results[] = [
            'ok' => false,
            'error' => [
                'code' => 'fixture_system_error',
                'message' => $error->getMessage(),
                'status_code' => 500,
            ],
        ];
    }
}

$json = json_encode($results, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
fwrite(STDOUT, $json . PHP_EOL);
