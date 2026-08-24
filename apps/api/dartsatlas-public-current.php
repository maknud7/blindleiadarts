<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Api\Service\DartsAtlasSyncService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\MembershipDatabase;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasHttpClient;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasParser;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

$timezone = new DateTimeZone('Europe/Oslo');

$parseVisibleDate = static function (string $raw) use ($timezone): ?DateTimeImmutable {
    $raw = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $raw = preg_replace('/\s+/u', ' ', trim($raw)) ?? trim($raw);
    if ($raw === '') {
        return null;
    }

    if (preg_match('/\b(20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?)?)/u', $raw, $iso)) {
        try {
            return (new DateTimeImmutable($iso[1], $timezone))->setTimezone($timezone);
        } catch (Throwable) {
            // Continue with DartsAtlas' visible schedule formats below.
        }
    }

    // Actual DartsAtlas season schedule format observed in production, e.g.
    // "2026 Aug 24 Monday 6:15pm CEST". DartsAtlas expresses the wall-clock
    // time in the season's local timezone, which for Blindleia is Europe/Oslo.
    if (preg_match(
        '/\b(20\d{2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))?\s+(\d{1,2}:\d{2})\s*(am|pm)(?:\s+(?:CEST|CET|UTC|GMT|BST|[+\-]\d{2}:?\d{2}))?/iu',
        $raw,
        $scheduleMatch
    )) {
        $dateText = sprintf(
            '%04d %s %02d %s%s',
            (int) $scheduleMatch[1],
            ucfirst(strtolower($scheduleMatch[2])),
            (int) $scheduleMatch[3],
            strtolower($scheduleMatch[4]),
            strtolower($scheduleMatch[5])
        );
        $parsed = DateTimeImmutable::createFromFormat('!Y M d g:ia', $dateText, $timezone);
        if ($parsed instanceof DateTimeImmutable) {
            return $parsed;
        }

        // Full month names are accepted by F even when M did not match.
        $parsed = DateTimeImmutable::createFromFormat('!Y F d g:ia', $dateText, $timezone);
        if ($parsed instanceof DateTimeImmutable) {
            return $parsed;
        }
    }

    if (!preg_match(
        '/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2})(?:\s*(?:·|,|\-|at)?\s*(\d{1,2}:\d{2})\s*(am|pm)?(?:\s+([A-Z]{2,5}|[+\-]\d{2}:?\d{2}))?)?/iu',
        $raw,
        $match
    )) {
        return null;
    }

    $dateText = sprintf('%02d %s %04d', (int) $match[1], ucfirst(strtolower($match[2])), (int) $match[3]);
    $clock = trim((string) ($match[4] ?? ''));
    $ampm = strtolower(trim((string) ($match[5] ?? '')));
    $zoneToken = strtoupper(trim((string) ($match[6] ?? '')));
    $sourceTimezone = $timezone;

    if ($zoneToken !== '') {
        try {
            $sourceTimezone = new DateTimeZone($zoneToken);
        } catch (Throwable) {
            $sourceTimezone = $timezone;
        }
    }

    if ($clock === '') {
        $parsed = DateTimeImmutable::createFromFormat('!d F Y', $dateText, $sourceTimezone);
    } elseif ($ampm !== '') {
        $parsed = DateTimeImmutable::createFromFormat('!d F Y g:ia', $dateText . ' ' . strtolower($clock . $ampm), $sourceTimezone);
    } else {
        $parsed = DateTimeImmutable::createFromFormat('!d F Y H:i', $dateText . ' ' . $clock, $sourceTimezone);
    }

    return $parsed instanceof DateTimeImmutable ? $parsed->setTimezone($timezone) : null;
};

$extractScheduledAt = static function (DOMXPath $xpath, DOMElement $anchor) use ($timezone, $parseVisibleDate): ?DateTimeImmutable {
    $node = $anchor;
    for ($depth = 0; $depth < 10 && $node instanceof DOMElement; $depth++, $node = $node->parentNode) {
        $timeNodes = $xpath->query('.//time', $node);
        if ($timeNodes !== false) {
            foreach ($timeNodes as $timeNode) {
                if (!$timeNode instanceof DOMElement) {
                    continue;
                }
                foreach (['datetime', 'data-datetime', 'data-start-at', 'data-start'] as $attribute) {
                    $raw = trim($timeNode->getAttribute($attribute));
                    if ($raw === '') {
                        continue;
                    }
                    try {
                        return (new DateTimeImmutable($raw, $timezone))->setTimezone($timezone);
                    } catch (Throwable) {
                        $parsed = $parseVisibleDate($raw);
                        if ($parsed !== null) {
                            return $parsed;
                        }
                    }
                }
                $parsed = $parseVisibleDate($timeNode->textContent);
                if ($parsed !== null) {
                    return $parsed;
                }
            }
        }

        foreach (['data-start-at', 'data-start', 'data-date', 'datetime'] as $attribute) {
            $raw = trim($node->getAttribute($attribute));
            if ($raw === '') {
                continue;
            }
            try {
                return (new DateTimeImmutable($raw, $timezone))->setTimezone($timezone);
            } catch (Throwable) {
                $parsed = $parseVisibleDate($raw);
                if ($parsed !== null) {
                    return $parsed;
                }
            }
        }

        $parsed = $parseVisibleDate($node->textContent);
        if ($parsed !== null) {
            return $parsed;
        }

        $sibling = $node->previousSibling;
        $checked = 0;
        while ($sibling !== null && $checked < 6) {
            if ($sibling instanceof DOMElement) {
                $parsed = $parseVisibleDate($sibling->textContent);
                if ($parsed !== null) {
                    return $parsed;
                }
                $checked++;
            }
            $sibling = $sibling->previousSibling;
        }
    }

    return null;
};

$extractName = static function (DOMXPath $xpath, DOMElement $anchor, string $externalId): string {
    $name = trim(preg_replace('/\s+/u', ' ', $anchor->textContent) ?? '');
    if ($name !== '' && !preg_match('/^(full details|details|view|open)$/iu', $name)) {
        return $name;
    }

    $node = $anchor;
    for ($depth = 0; $depth < 6 && $node instanceof DOMElement; $depth++, $node = $node->parentNode) {
        $headings = $xpath->query('.//h1|.//h2|.//h3|.//h4|.//strong', $node);
        if ($headings === false) {
            continue;
        }
        foreach ($headings as $heading) {
            $candidate = trim(preg_replace('/\s+/u', ' ', $heading->textContent) ?? '');
            if ($candidate !== '') {
                return $candidate;
            }
        }
    }

    return $externalId;
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $dartsAtlas = $config->dartsAtlas();
    $seasonExternalId = trim($dartsAtlas->seasonId());

    if ($seasonExternalId === '') {
        throw new RuntimeException('DartsAtlas season id is not configured.');
    }

    $seasonBaseUrl = 'https://www.dartsatlas.com/seasons/' . rawurlencode($seasonExternalId);
    $sourceUrls = [
        $seasonBaseUrl . '/tournaments/schedule',
        $seasonBaseUrl,
    ];
    $attemptedUrls = [];
    $selectedSourceUrl = null;
    $candidates = [];
    $today = new DateTimeImmutable('today', $timezone);
    $http = new DartsAtlasHttpClient($dartsAtlas->userAgent(), 8, 20);

    foreach ($sourceUrls as $sourceUrl) {
        try {
            $response = $http->get($sourceUrl);
            $attemptedUrls[] = ['url' => $sourceUrl, 'status' => $response->status];
            $html = $response->body;
        } catch (Throwable $error) {
            $attemptedUrls[] = ['url' => $sourceUrl, 'status' => 'failed'];
            continue;
        }

        $document = new DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        if (!$loaded) {
            continue;
        }

        $xpath = new DOMXPath($document);
        $anchors = $xpath->query('//a[contains(@href,"/tournaments/")]');
        if ($anchors === false) {
            continue;
        }

        foreach ($anchors as $anchor) {
            if (!$anchor instanceof DOMElement) {
                continue;
            }
            $href = html_entity_decode($anchor->getAttribute('href'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if (!preg_match('~/tournaments/([^/?#]+)~', $href, $match)) {
                continue;
            }

            $externalId = trim($match[1]);
            if ($externalId === '' || in_array($externalId, ['schedule', 'calendar', 'results', 'search'], true)) {
                continue;
            }

            $scheduledAt = $extractScheduledAt($xpath, $anchor);
            if ($scheduledAt === null || $scheduledAt->setTime(0, 0) < $today) {
                continue;
            }

            $candidate = [
                'external_id' => $externalId,
                'name' => $extractName($xpath, $anchor, $externalId),
                'scheduled_at' => $scheduledAt,
            ];

            if (!isset($candidates[$externalId]) || $scheduledAt < $candidates[$externalId]['scheduled_at']) {
                $candidates[$externalId] = $candidate;
            }
        }

        if ($candidates !== []) {
            $selectedSourceUrl = $sourceUrl;
            break;
        }
    }

    uasort($candidates, static fn(array $a, array $b): int => $a['scheduled_at'] <=> $b['scheduled_at']);
    $selected = $candidates !== [] ? reset($candidates) : null;

    if (!is_array($selected)) {
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'tournament_id' => null,
                'external_id' => null,
                'scheduled_at' => null,
                'status' => 'no_today_or_future_tournament',
                'source' => [
                    'attempted_urls' => $attemptedUrls,
                    'selected_url' => null,
                    'candidate_count' => 0,
                ],
            ],
        ]);
    }

    $externalId = (string) $selected['external_id'];
    $references = $prefix . 'external_references';
    $resolveLocalId = static function () use ($db, $references, $externalId): ?int {
        $statement = $db->prepare(
            "SELECT internal_id FROM `{$references}`
             WHERE external_system='dartsatlas'
               AND external_entity_type='tournament'
               AND external_id=?
               AND internal_entity_type='tournament'
             LIMIT 1"
        );
        $statement->bind_param('s', $externalId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        return $row !== null ? (int) $row['internal_id'] : null;
    };

    $localId = $resolveLocalId();
    if ($localId === null) {
        $clubId = $dartsAtlas->clubId();
        if ($clubId <= 0) {
            $slug = trim($config->screenDefaultClubSlug());
            if ($slug !== '') {
                $statement = $db->prepare("SELECT id FROM `{$prefix}clubs` WHERE slug=? LIMIT 1");
                $statement->bind_param('s', $slug);
                $statement->execute();
                $row = $statement->get_result()->fetch_assoc() ?: null;
                $statement->close();
                if ($row !== null) {
                    $clubId = (int) $row['id'];
                    $dartsAtlas = $dartsAtlas->withClubId($clubId);
                }
            }
        }

        if ($clubId > 0 && $dartsAtlas->localSeasonId() === null) {
            $statement = $db->prepare("SELECT id FROM `{$prefix}seasons` WHERE club_id=? ORDER BY is_active DESC, id DESC LIMIT 1");
            $statement->bind_param('i', $clubId);
            $statement->execute();
            $row = $statement->get_result()->fetch_assoc() ?: null;
            $statement->close();
            if ($row !== null) {
                $dartsAtlas = $dartsAtlas->withLocalSeasonId((int) $row['id']);
            }
        }

        if ($clubId > 0) {
            $membership = new MembershipDatabase($config, $database, $dartsAtlas->membersTable());
            $membership->prepareRepositoryBridge();
            $repository = new DartsAtlasRepository($database, $dartsAtlas->membersTable());
            $service = new DartsAtlasSyncService(
                new DartsAtlasHttpClient($dartsAtlas->userAgent()),
                new DartsAtlasParser(),
                $repository,
                $dartsAtlas,
            );
            $service->syncSeason($seasonExternalId, $externalId);
            $localId = $resolveLocalId();
        }
    }

    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'tournament_id' => $localId,
            'external_id' => $externalId,
            'name' => (string) $selected['name'],
            'scheduled_at' => $selected['scheduled_at']->format(DateTimeInterface::ATOM),
            'scheduled_date' => $selected['scheduled_at']->format('Y-m-d'),
            'is_today' => $selected['scheduled_at']->format('Y-m-d') === $today->format('Y-m-d'),
            'status' => $localId !== null ? 'resolved' : 'scheduled_not_synced',
            'source' => [
                'attempted_urls' => $attemptedUrls,
                'selected_url' => $selectedSourceUrl,
                'candidate_count' => count($candidates),
            ],
        ],
    ]);
} catch (Throwable $error) {
    $payload = [
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_current_tournament_unavailable',
            'message' => 'Could not resolve the current DartsAtlas tournament.',
        ],
    ];
    if (isset($config) && $config instanceof Config && $config->appEnv() !== 'prod') {
        $payload['error']['detail'] = $error->getMessage();
    }
    $respond($payload, 503);
}
