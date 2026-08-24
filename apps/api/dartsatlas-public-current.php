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

$extractScheduledAt = static function (DOMXPath $xpath, DOMElement $anchor): ?DateTimeImmutable {
    $node = $anchor;
    for ($depth = 0; $depth < 7 && $node instanceof DOMElement; $depth++, $node = $node->parentNode) {
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
                        return new DateTimeImmutable($raw);
                    } catch (Throwable) {
                        // Fall through to visible text parsing.
                    }
                }
                $raw = trim($timeNode->textContent);
                if ($raw !== '') {
                    $timestamp = strtotime($raw);
                    if ($timestamp !== false) {
                        return (new DateTimeImmutable('@' . $timestamp));
                    }
                }
            }
        }

        foreach (['data-start-at', 'data-start', 'data-date', 'datetime'] as $attribute) {
            $raw = trim($node->getAttribute($attribute));
            if ($raw === '') {
                continue;
            }
            try {
                return new DateTimeImmutable($raw);
            } catch (Throwable) {
                // Continue with text parsing.
            }
        }

        $text = preg_replace('/\s+/u', ' ', trim($node->textContent)) ?? '';
        if ($text !== '') {
            if (preg_match('/\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+20\d{2}(?:\s*[·,-]?\s*\d{1,2}:\d{2}\s*(?:am|pm)?)?)/iu', $text, $match)) {
                $timestamp = strtotime($match[1]);
                if ($timestamp !== false) {
                    return new DateTimeImmutable('@' . $timestamp);
                }
            }
            if (preg_match('/\b(20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/u', $text, $match)) {
                try {
                    return new DateTimeImmutable($match[1]);
                } catch (Throwable) {
                    // No usable date in this container.
                }
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

    $calendarUrl = 'https://www.dartsatlas.com/seasons/' . rawurlencode($seasonExternalId) . '/tournaments/calendar';
    $curl = curl_init($calendarUrl);
    if ($curl === false) {
        throw new RuntimeException('Could not initialise DartsAtlas calendar request.');
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
    curl_close($curl);

    if (!is_string($html) || $html === '' || $status < 200 || $status >= 400) {
        throw new RuntimeException('DartsAtlas calendar request failed' . ($error !== '' ? ': ' . $error : '.'));
    }

    $document = new DOMDocument();
    $previous = libxml_use_internal_errors(true);
    $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);
    if (!$loaded) {
        throw new RuntimeException('Could not parse DartsAtlas calendar.');
    }

    $xpath = new DOMXPath($document);
    $anchors = $xpath->query('//a[contains(@href,"/tournaments/")]');
    $timezone = new DateTimeZone('Europe/Oslo');
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
            $scheduledDay = $scheduledAt->setTime(0, 0);
            if ($scheduledDay < $today) {
                continue;
            }
            $candidates[$externalId] = [
                'external_id' => $externalId,
                'name' => trim(preg_replace('/\s+/u', ' ', $anchor->textContent) ?? ''),
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
            'name' => $selected['name'] !== '' ? $selected['name'] : $externalId,
            'scheduled_at' => $selected['scheduled_at']->format(DateTimeInterface::ATOM),
            'scheduled_date' => $selected['scheduled_at']->format('Y-m-d'),
            'is_today' => $selected['scheduled_at']->format('Y-m-d') === $today->format('Y-m-d'),
            'status' => $localId !== null ? 'resolved' : 'scheduled_not_synced',
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_current_tournament_unavailable',
            'message' => 'Could not resolve the current DartsAtlas tournament.',
            'detail' => $config->appEnv() === 'prod' ? null : $error->getMessage(),
        ],
    ], 503);
}
