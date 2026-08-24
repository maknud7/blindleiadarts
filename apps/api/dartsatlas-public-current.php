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
    $raw = preg_replace('/\s+/u', ' ', trim($raw)) ?? trim($raw);
    if ($raw === '') {
        return null;
    }

    if (!preg_match(
        '/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2})(?:\s*[·,\-]?\s*(\d{1,2}:\d{2})\s*(am|pm)?(?:\s+([A-Z]{2,5}|[+\-]\d{2}:?\d{2}))?)?/iu',
        $raw,
        $match
    )) {
        return null;
    }

    $day = (int) $match[1];
    $month = ucfirst(strtolower($match[2]));
    $year = (int) $match[3];
    $clock = trim((string) ($match[4] ?? ''));
    $ampm = strtolower(trim((string) ($match[5] ?? '')));
    $zoneToken = trim((string) ($match[6] ?? ''));

    $dateText = sprintf('%02d %s %04d', $day, $month, $year);
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
                        return (new DateTimeImmutable($raw))->setTimezone($timezone);
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
                return (new DateTimeImmutable($raw))->setTimezone($timezone);
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

        $text = preg_replace('/\s+/u', ' ', trim($node->textContent)) ?? '';
        if (preg_match('/\b(20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?)?)/u', $text, $match)) {
            try {
                return (new DateTimeImmutable($match[1], $timezone))->setTimezone($timezone);
            } catch (Throwable) {
                // Continue walking towards the tournament card container.
            }
        }
    }

    return null;
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

    // The canonical public season page is the source of truth for the next
    // scheduled tournament. Do not invent a /tournaments/calendar sub-route.
    $seasonUrl = 'https://www.dartsatlas.com/seasons/' . rawurlencode($seasonExternalId);
    $curl = curl_init($seasonUrl);
    if ($curl === false) {
        throw new RuntimeException('Could not initialise DartsAtlas season request.');
    }
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => $dartsAtlas->userAgent(),
        CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml'],
    ]);
    $html = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    $effectiveUrl = (string) curl_getinfo($curl, CURLINFO_EFFECTIVE_URL);
    curl_close($curl);

    if (!is_string($html) || $html === '' || $status < 200 || $status >= 400) {
        throw new RuntimeException('DartsAtlas season request failed' . ($error !== '' ? ': ' . $error : '.'));
    }

    $document = new DOMDocument();
    $previous = libxml_use_internal_errors(true);
    $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);
    if (!$loaded) {
        throw new RuntimeException('Could not parse DartsAtlas season page.');
    }

    $xpath = new DOMXPath($document);
    $anchors = $xpath->query('//a[contains(@href,"/tournaments/")]');
    $today = new DateTimeImmutable('today', $timezone);
    $candidates = [];

    if ($anchors !== false) {
        foreach ($anchors as $anchor) {
            if (!$anchor instanceof DOMElement) {
                continue;
            }
            $href = html_entity_decode($anchor->getAttribute('href'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if (!preg_match('~/tournaments/([^/?#]+)~', $href, $match)) {
                continue;
            }
            $externalId = trim($match[1]);
            if ($externalId === '' || isset($candidates[$externalId])) {
                continue;
            }

            $scheduledAt = $extractScheduledAt($xpath, $anchor);
            if ($scheduledAt === null) {
                continue;
            }
            $scheduledAt = $scheduledAt->setTimezone($timezone);
            if ($scheduledAt->setTime(0, 0) < $today) {
                continue;
            }

            $name = trim(preg_replace('/\s+/u', ' ', $anchor->textContent) ?? '');
            if ($name === '') {
                $name = $externalId;
            }

            $candidates[$externalId] = [
                'external_id' => $externalId,
                'name' => $name,
                'scheduled_at' => $scheduledAt,
            ];
        }
    }

    uasort($candidates, static function (array $a, array $b): int {
        return $a['scheduled_at'] <=> $b['scheduled_at'];
    });
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
                    'season_url' => $seasonUrl,
                    'effective_url' => $effectiveUrl,
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
            $clubsTable = $prefix . 'clubs';
            $slug = trim($config->screenDefaultClubSlug());
            if ($slug !== '') {
                $statement = $db->prepare("SELECT id FROM `{$clubsTable}` WHERE slug=? LIMIT 1");
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
            $seasonsTable = $prefix . 'seasons';
            $statement = $db->prepare("SELECT id FROM `{$seasonsTable}` WHERE club_id=? ORDER BY is_active DESC, id DESC LIMIT 1");
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
                'season_url' => $seasonUrl,
                'effective_url' => $effectiveUrl,
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
