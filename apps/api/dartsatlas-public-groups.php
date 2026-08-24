<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasHttpClient;
use DOMDocument;
use DOMElement;
use DOMXPath;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

$cleanText = static function (string $value): string {
    $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string) preg_replace('/\s+/u', ' ', $value));
};

$asInt = static function (?string $value): ?int {
    if ($value === null) {
        return null;
    }
    $value = trim($value);
    if ($value === '' || !preg_match('/[-+]?\d+/', $value, $match)) {
        return null;
    }
    return (int) $match[0];
};

$asFloat = static function (?string $value): ?float {
    if ($value === null) {
        return null;
    }
    $value = str_replace(',', '.', trim($value));
    if ($value === '' || !is_numeric($value)) {
        return null;
    }
    return (float) $value;
};

$parseGroups = static function (string $html, string $externalTournamentId) use ($cleanText, $asInt, $asFloat): array {
    if (!class_exists(DOMDocument::class)) {
        return ['external_id' => $externalTournamentId, 'groups' => []];
    }

    $document = new DOMDocument();
    $previous = libxml_use_internal_errors(true);
    $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);

    if (!$loaded) {
        return ['external_id' => $externalTournamentId, 'groups' => []];
    }

    $xpath = new DOMXPath($document);
    $headings = $xpath->query('//h2[contains(translate(normalize-space(.), "GROUP", "group"), "group")]');
    $groups = [];

    if ($headings === false) {
        return ['external_id' => $externalTournamentId, 'groups' => []];
    }

    foreach ($headings as $heading) {
        if (!$heading instanceof DOMElement) {
            continue;
        }

        $label = $cleanText($heading->textContent);
        if (!preg_match('/\bgroup\s*([A-Za-z0-9]+)?/iu', $label)) {
            continue;
        }

        $table = null;
        for ($node = $heading->nextSibling; $node !== null; $node = $node->nextSibling) {
            if ($node instanceof DOMElement && strtolower($node->tagName) === 'h2') {
                break;
            }
            if ($node instanceof DOMElement && strtolower($node->tagName) === 'table') {
                $table = $node;
                break;
            }
            if ($node instanceof DOMElement) {
                $candidate = $xpath->query('.//table[1]', $node);
                if ($candidate !== false && $candidate->length > 0 && $candidate->item(0) instanceof DOMElement) {
                    $table = $candidate->item(0);
                    break;
                }
            }
        }

        if (!$table instanceof DOMElement) {
            continue;
        }

        $rows = [];
        $trNodes = $xpath->query('.//tr', $table);
        if ($trNodes === false) {
            continue;
        }

        foreach ($trNodes as $tr) {
            if (!$tr instanceof DOMElement) {
                continue;
            }
            $cells = $xpath->query('./th|./td', $tr);
            if ($cells === false || $cells->length < 8) {
                continue;
            }

            $values = [];
            foreach ($cells as $cell) {
                $values[] = $cleanText($cell->textContent);
            }
            if (!preg_match('/^\d+$/', $values[0] ?? '')) {
                continue;
            }

            $playerCell = $cells->item(1);
            $playerExternalId = null;
            if ($playerCell instanceof DOMElement) {
                $anchor = $xpath->query('.//a[@href][1]', $playerCell);
                if ($anchor !== false && $anchor->length > 0 && $anchor->item(0) instanceof DOMElement) {
                    $href = html_entity_decode($anchor->item(0)->getAttribute('href'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                    foreach ([
                        '~/player_stats/([^/?#]+)~',
                        '~/players/([^/?#]+)~',
                        '~/profiles/([^/?#]+)~',
                    ] as $pattern) {
                        if (preg_match($pattern, $href, $match)) {
                            $playerExternalId = $match[1];
                            break;
                        }
                    }
                }
            }

            $rows[] = [
                'position' => (int) $values[0],
                'player_name' => $values[1] ?? '',
                'player_external_id' => $playerExternalId,
                'average' => $asFloat($values[2] ?? null),
                'wins' => $asInt($values[3] ?? null) ?? 0,
                'losses' => $asInt($values[4] ?? null) ?? 0,
                'la' => $asInt($values[5] ?? null),
                'leg_diff' => $asInt($values[6] ?? null),
                'points' => $asInt($values[7] ?? null) ?? 0,
            ];
        }

        if ($rows !== []) {
            $groups[] = [
                'label' => $label,
                'standings' => $rows,
            ];
        }
    }

    return [
        'external_id' => $externalTournamentId,
        'groups' => $groups,
    ];
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $requested = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT);
    $tournamentId = is_int($requested) && $requested > 0 ? $requested : 0;
    if ($tournamentId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'tournament_required', 'message' => 'tournament_id mangler.']], 422);
    }

    $tournaments = $prefix . 'tournaments';
    $references = $prefix . 'external_references';
    $statement = $db->prepare(
        "SELECT er.external_id
         FROM `{$tournaments}` t
         INNER JOIN `{$references}` er
           ON er.external_system='dartsatlas'
          AND er.external_entity_type='tournament'
          AND er.internal_entity_type='tournament'
          AND er.internal_id=t.id
         WHERE t.id=? AND t.provider_system='dartsatlas'
         LIMIT 1"
    );
    $statement->bind_param('i', $tournamentId);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($row === null) {
        $respond(['ok' => false, 'error' => ['code' => 'tournament_not_found', 'message' => 'DartsAtlas-turneringen finnes ikke.']], 404);
    }

    $externalId = trim((string) $row['external_id']);
    $repository = new DartsAtlasRepository($database, $config->dartsAtlas()->membersTable());
    $resourceType = 'tournament_groups';
    $cachedPayload = $repository->resourcePayload($resourceType, $externalId);

    $resources = $prefix . 'connector_resources';
    $ageStatement = $db->prepare(
        "SELECT TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS age_seconds
         FROM `{$resources}`
         WHERE external_system='dartsatlas' AND resource_type=? AND external_id=?
         LIMIT 1"
    );
    $ageStatement->bind_param('ss', $resourceType, $externalId);
    $ageStatement->execute();
    $ageRow = $ageStatement->get_result()->fetch_assoc() ?: [];
    $ageStatement->close();
    $ageSeconds = isset($ageRow['age_seconds']) ? (int) $ageRow['age_seconds'] : null;

    if ($cachedPayload !== null && $ageSeconds !== null && $ageSeconds < 20) {
        $respond(['ok' => true, 'data' => $cachedPayload + ['cache_age_seconds' => $ageSeconds]]);
    }

    $url = "https://www.dartsatlas.com/tournaments/{$externalId}/groups";
    $cache = $repository->resourceCache($resourceType, $externalId);
    $http = new DartsAtlasHttpClient($config->dartsAtlas()->userAgent());
    $response = $http->get(
        $url,
        isset($cache['etag']) ? (string) $cache['etag'] : null,
        isset($cache['last_modified']) ? (string) $cache['last_modified'] : null,
    );

    if ($response->status === 304 && $cachedPayload !== null) {
        $repository->upsertResource(
            $resourceType,
            $externalId,
            $url,
            304,
            $response->header('etag') ?? ($cache['etag'] ?? null),
            $response->header('last-modified') ?? ($cache['last_modified'] ?? null),
            isset($cache['content_hash']) ? (string) $cache['content_hash'] : null,
            $externalId,
            $cachedPayload,
            false,
        );
        $respond(['ok' => true, 'data' => $cachedPayload + ['cache_age_seconds' => 0]]);
    }

    $payload = $parseGroups($response->body, $externalId);
    $hash = hash('sha256', $response->body);
    $changed = !isset($cache['content_hash']) || (string) $cache['content_hash'] !== $hash;
    $repository->upsertResource(
        $resourceType,
        $externalId,
        $response->url,
        $response->status,
        $response->header('etag'),
        $response->header('last-modified'),
        $hash,
        $externalId,
        $payload,
        $changed,
    );

    $respond(['ok' => true, 'data' => $payload + ['cache_age_seconds' => 0]]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_groups_unavailable',
            'message' => 'Gruppetabellene kunne ikke hentes fra DartsAtlas.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 503);
}
