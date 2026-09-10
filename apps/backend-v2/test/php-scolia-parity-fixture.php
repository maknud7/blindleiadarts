<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ScoliaRoutedEventRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\ScoliaSectorMapper;

require dirname(__DIR__, 2) . '/api/bootstrap.php';

$raw = stream_get_contents(STDIN);
$cases = json_decode($raw !== false ? $raw : '[]', true, 512, JSON_THROW_ON_ERROR);
if (!is_array($cases)) {
    throw new RuntimeException('Expected JSON array.');
}

$mapper = new ScoliaSectorMapper();
$repoReflection = new ReflectionClass(ScoliaRoutedEventRepository::class);
$repo = $repoReflection->newInstanceWithoutConstructor();
$priorityMethod = $repoReflection->getMethod('eventPriority');
$priorityMethod->setAccessible(true);

$output = [];
foreach ($cases as $case) {
    if (!is_array($case)) {
        continue;
    }

    $operation = (string) ($case['operation'] ?? '');
    try {
        if ($operation === 'sector') {
            $output[] = [
                'ok' => true,
                'value' => $mapper->toCanonical(
                    (string) ($case['sector'] ?? ''),
                    (bool) ($case['bounceout'] ?? false)
                ),
            ];
            continue;
        }

        if ($operation === 'priority') {
            $output[] = [
                'ok' => true,
                'value' => $priorityMethod->invoke($repo, strtoupper(trim((string) ($case['type'] ?? 'UNKNOWN')))),
            ];
            continue;
        }

        if ($operation === 'request_key') {
            $eventIds = is_array($case['event_ids'] ?? null) ? array_values($case['event_ids']) : [];
            $output[] = [
                'ok' => true,
                'value' => 'scolia-' . hash('sha256', implode(',', $eventIds)),
            ];
            continue;
        }

        throw new RuntimeException('Unknown fixture operation.');
    } catch (ValidationException $error) {
        $output[] = [
            'ok' => false,
            'error' => [
                'code' => $error->errorCode(),
                'status' => $error->statusCode(),
                'message' => $error->getMessage(),
            ],
        ];
    }
}

echo json_encode($output, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
