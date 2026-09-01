<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};

if (PHP_SAPI !== 'cli') throw new RuntimeException('CLI only.');
if ($required('DB_TABLE_PREFIX') !== 'bd_test_') throw new RuntimeException('Summary staging is TEST-only.');
if ($required('ALLOW_TEST_ROUND_FOUR_SUMMARY') !== 'yes') {
    throw new RuntimeException('Refusing TEST summary staging without explicit allow flag.');
}

$fixturePath = $argv[1] ?? '';
if ($fixturePath === '' || !is_file($fixturePath)) throw new RuntimeException('Missing summary fixture.');
$fixture = json_decode((string) file_get_contents($fixturePath), true, 512, JSON_THROW_ON_ERROR);
$externalId = (string) ($fixture['tournament_external_id'] ?? '');
$title = trim((string) ($fixture['title'] ?? ''));
$body = trim((string) ($fixture['body_text'] ?? ''));
if ($externalId !== 'jort2WSBWFwN' || $title === '' || $body === '') {
    throw new RuntimeException('Frozen round-four summary fixture is invalid.');
}

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = 'bd_test_';

$stmt = $db->prepare(
    "SELECT t.id,t.status,t.end_at
     FROM `{$prefix}external_references` er
     INNER JOIN `{$prefix}tournaments` t ON t.id=er.internal_id
     WHERE er.external_system='dartsatlas' AND er.external_entity_type='tournament'
       AND er.external_id=? AND er.internal_entity_type='tournament' LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$tournament = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
if ($tournament === null || (string) $tournament['status'] !== 'completed' || empty($tournament['end_at'])) {
    throw new RuntimeException('Canonical completed TEST round four is required before summary publication.');
}
$tournamentId = (int) $tournament['id'];

$stmt = $db->prepare(
    "INSERT INTO `{$prefix}tournament_summaries`
       (tournament_id,title,body_text,status,published_at,created_by_user_account_id,updated_by_user_account_id)
     VALUES (?,?,?,'published',NOW(),NULL,NULL)
     ON DUPLICATE KEY UPDATE
       title=VALUES(title),body_text=VALUES(body_text),status='published',
       published_at=COALESCE(published_at,NOW()),updated_by_user_account_id=NULL"
);
$stmt->bind_param('iss', $tournamentId, $title, $body);
$stmt->execute();
$stmt->close();

$verify = $db->prepare(
    "SELECT title,body_text,status,published_at FROM `{$prefix}tournament_summaries` WHERE tournament_id=? LIMIT 1"
);
$verify->bind_param('i', $tournamentId);
$verify->execute();
$saved = $verify->get_result()->fetch_assoc() ?: null;
$verify->close();
if ($saved === null || (string) $saved['status'] !== 'published'
    || (string) $saved['title'] !== $title || (string) $saved['body_text'] !== $body
    || empty($saved['published_at'])) {
    throw new RuntimeException('TEST round-four summary verification failed.');
}

fwrite(STDOUT, "ROUND4_TEST_SUMMARY_PUBLISHED=yes tournament_id={$tournamentId}\n");
