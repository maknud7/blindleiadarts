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
$cleanText = static function (string $value): string {
    $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string) preg_replace('/\s+/u', ' ', $value));
};

$parseVisibleDate = static function (string $raw) use ($timezone, $cleanText): ?DateTimeImmutable {
    $raw = $cleanText($raw);
    if ($raw === '') {
        return null;
    }

    if (preg_match('/\b(20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?)?)/u', $raw, $iso)) {
        try {
            return (new DateTimeImmutable($iso[1], $timezone))->setTimezone($timezone);
        } catch (Throwable) {
            // Continue with visible DartsAtlas formats.
        }
    }

    if (preg_match(
        '/\b(20\d{2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))?\s+(\d{1,2}:\d{2})\s*(am|pm)(?:\s+(?:CEST|CET|UTC|GMT|BST|[+\-]\d{2}:?\d{2}))?/iu',
        $raw,
        $match
    )) {
        $dateText = sprintf(
            '%04d %s %02d %s%s',
            (int) $match[1],
            ucfirst(strtolower($match[2])),
            (int) $match[3],
            strtolower($match[4]),
            strtolower($match[5])
        );
        foreach (['!Y M d g:ia', '!Y F d g:ia'] as $format) {
            $parsed = DateTimeImmutable::createFromFormat($format, $dateText, $timezone);
            if ($parsed instanceof DateTimeImmutable) {
                return $parsed;
            }
        }
    }

    if (preg_match(
        '/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2})(?:\s*(?:·|,|\-|at)?\s*(\d{1,2}:\d{2})\s*(am|pm)?(?:\s+([A-Z]{2,5}|[+\-]\d{2}:?\d{2}))?)?/iu',
        $raw,
        $match
    )) {
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
        if ($parsed instanceof DateTimeImmutable) {
            return $parsed->setTimezone($timezone);
        }
    }

    return null;
};

$loadDocument = static function (string $html): ?array {
    if (!class_exists(DOMDocument::class)) {
        return null;
    }
    $document = new DOMDocument();
    $previous = libxml_use_internal_errors(true);
    $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);
    if (!$loaded) {
        return null;
    }
    return [$document, new DOMXPath($document)];
};

$externalIdFromAnchor = static function (DOMElement $anchor): ?string {
    $href = html_entity_decode($anchor->getAttribute('href'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if (!preg_match('~/tournaments/([^/?#]+)~', $href, $match)) {
        return null;
    }
    $externalId = trim($match[1]);
    if ($externalId === '' || in_array($externalId, ['schedule', 'calendar', 'results', 'search'], true)) {
        return null;
    }
    return $externalId;
};

$extractName = static function (DOMXPath $xpath, DOMElement $anchor, string $externalId) use ($cleanText): string {
    $name = $cleanText($anchor->textContent);
    if ($name !== '' && !preg_match('/^(full details|details|view|open)$/iu', $name)) {
        return $name;
    }

    $node = $anchor;
    for ($depth = 0; $depth < 5 && $node instanceof DOMElement; $depth++, $node = $node->parentNode) {
        $headings = $xpath->query('.//h1|.//h2|.//h3|.//h4|.//strong', $node);
        if ($headings === false) {
            continue;
        }
        foreach ($headings as $heading) {
            $candidate = $cleanText($heading->textContent);
            if ($candidate !== '' && !preg_match('/^in\s+progress$/iu', $candidate)) {
                return $candidate;
            }
        }
    }
    return $externalId;
};

$extractScheduledAt = static function (DOMXPath $xpath, DOMElement $anchor) use ($timezone, $parseVisibleDate): ?DateTimeImmutable {
    $node = $anchor;
    for ($depth = 0; $depth < 8 && $node instanceof DOMElement; $depth++, $node = $node->parentNode) {
        $timeNodes = $xpath->query('.//time', $node);
        if ($timeNodes !== false) {
            foreach ($timeNodes as $timeNode) {
                if (!$timeNode instanceof DOMElement) {
                    continue;
                }
                foreach (['datetime', 'data-datetime', 'data-start-at', 'data-start'] as $attribute) {
                    $raw = trim($timeNode->getAttribute($attribute));
                    if ($raw !== '') {
                        try {
                            return (new DateTimeImmutable($raw, $timezone))->setTimezone($timezone);
                        } catch (Throwable) {
                            $parsed = $parseVisibleDate($raw);
                            if ($parsed !== null) {
                                return $parsed;
                            }
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
            if ($raw !== '') {
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
        while ($sibling !== null && $checked < 5) {
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

$findInProgressTournament = static function (string $html) use ($loadDocument, $externalIdFromAnchor, $extractName, $cleanText): ?array {
    $loaded = $loadDocument($html);
    if ($loaded === null) {
        return null;
    }
    [$document, $xpath] = $loaded;

    $statusNodes = $xpath->query('//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "in progress")]');
    if ($statusNodes === false) {
        return null;
    }

    foreach ($statusNodes as $statusNode) {
        if (!$statusNode instanceof DOMElement) {
            continue;
        }
        $ownText = $cleanText($statusNode->textContent);
        if ($ownText === '' || mb_strlen($ownText) > 500) {
            continue;
        }

        $node = $statusNode;
        for ($depth = 0; $depth < 5 && $node instanceof DOMElement; $depth++, $node = $node->parentNode) {
            $tag = strtolower($node->tagName);
            if (in_array($tag, ['body', 'html'], true)) {
                break;
            }
            $contextText = $cleanText($node->textContent);
            if (!preg_match('/\bin\s+progress\b/iu', $contextText) || mb_strlen($contextText) > 1600) {
                continue;
            }

            $anchors = $xpath->query('.//a[contains(@href,"/tournaments/")]', $node);
            if ($anchors === false || $anchors->length === 0) {
                continue;
            }
            foreach ($anchors as $anchor) {
                if (!$anchor instanceof DOMElement) {
                    continue;
                }
                $externalId = $externalIdFromAnchor($anchor);
                if ($externalId === null) {
                    continue;
                }
                return [
                    'external_id' => $externalId,
                    'name' => $extractName($xpath, $anchor, $externalId),
                ];
            }
        }
    }

    return null;
};

$parseSchedule = static function (string $html, DateTimeImmutable $today) use (
    $loadDocument,
    $externalIdFromAnchor,
    $extractName,
    $extractScheduledAt
): array {
    $loaded = $loadDocument($html);
    if ($loaded === null) {
        return [];
    }
    [$document, $xpath] = $loaded;
    $anchors = $xpath->query('//a[contains(@href,"/tournaments/")]');
    if ($anchors === false) {
        return [];
    }

    $candidates = [];
    foreach ($anchors as $anchor) {
        if (!$anchor instanceof DOMElement) {
            continue;
        }
        $externalId = $externalIdFromAnchor($anchor);
        if ($externalId === null) {
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
    uasort($candidates, static fn(array $a, array $b): int => $a['scheduled_at'] <=> $b['scheduled_at']);
    return array_values($candidates);
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
    if ($clubId <= 0) {
        throw new RuntimeException('Could not resolve DartsAtlas club.');
    }

    if ($dartsAtlas->localSeasonId() === null) {
        $statement = $db->prepare("SELECT id FROM `{$prefix}seasons` WHERE club_id=? ORDER BY is_active DESC, id DESC LIMIT 1");
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        if ($row !== null) {
            $dartsAtlas = $dartsAtlas->withLocalSeasonId((int) $row['id']);
        }
    }

    $membership = new MembershipDatabase($config, $database, $dartsAtlas->membersTable());
    $membership->prepareRepositoryBridge();
    $repository = new DartsAtlasRepository($database, $dartsAtlas->membersTable());
    $service = new DartsAtlasSyncService(
        new DartsAtlasHttpClient($dartsAtlas->userAgent()),
        new DartsAtlasParser(),
        $repository,
        $dartsAtlas,
    );
    $http = new DartsAtlasHttpClient($dartsAtlas->userAgent(), 8, 20);
    $references = $prefix . 'external_references';
    $tournaments = $prefix . 'tournaments';

    $resolveLocalId = static function (string $externalId) use ($db, $references): ?int {
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

    $syncTournament = static function (string $externalId) use ($service, $seasonExternalId, $resolveLocalId): ?int {
        $service->syncSeason($seasonExternalId, $externalId);
        return $resolveLocalId($externalId);
    };

    $persistSchedule = static function (int $localId, DateTimeImmutable $scheduledAt) use ($db, $tournaments): void {
        $start = $scheduledAt->format('Y-m-d H:i:s');
        $statement = $db->prepare(
            "UPDATE `{$tournaments}`
             SET start_at=?
             WHERE id=? AND status <> 'archived'"
        );
        $statement->bind_param('si', $start, $localId);
        $statement->execute();
        $statement->close();
    };

    $localTournament = static function (int $localId) use ($db, $tournaments): ?array {
        $statement = $db->prepare("SELECT id, name, status, start_at FROM `{$tournaments}` WHERE id=? LIMIT 1");
        $statement->bind_param('i', $localId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        return $row;
    };

    $today = new DateTimeImmutable('today', $timezone);
    $tomorrow = $today->modify('+1 day');
    $seasonUrl = 'https://www.dartsatlas.com/seasons/' . rawurlencode($seasonExternalId);
    $scheduleUrl = $seasonUrl . '/tournaments/schedule';
    $attempted = [];

    // 1) The season page is the strongest provider signal while a tournament is running.
    try {
        $seasonResponse = $http->get($seasonUrl);
        $attempted[] = ['url' => $seasonUrl, 'status' => $seasonResponse->status];
        $inProgress = $findInProgressTournament($seasonResponse->body);
        if (is_array($inProgress)) {
            $externalId = (string) $inProgress['external_id'];
            $localId = $resolveLocalId($externalId) ?? $syncTournament($externalId);
            if ($localId !== null) {
                $local = $localTournament($localId);
                $scheduledAt = isset($local['start_at']) && $local['start_at'] !== null
                    ? new DateTimeImmutable((string) $local['start_at'], $timezone)
                    : null;
                $respond([
                    'ok' => true,
                    'generated_at' => gmdate('c'),
                    'data' => [
                        'tournament_id' => $localId,
                        'external_id' => $externalId,
                        'name' => (string) ($local['name'] ?? $inProgress['name']),
                        'scheduled_at' => $scheduledAt?->format(DateTimeInterface::ATOM),
                        'scheduled_date' => $scheduledAt?->format('Y-m-d') ?? $today->format('Y-m-d'),
                        'is_today' => true,
                        'status' => 'in_progress',
                        'source' => [
                            'mode' => 'season_in_progress',
                            'attempted_urls' => $attempted,
                            'selected_url' => $seasonUrl,
                        ],
                    ],
                ]);
            }
        }
    } catch (Throwable) {
        $attempted[] = ['url' => $seasonUrl, 'status' => 'failed'];
    }

    // 2) If this tournament was seen in schedule before start, keep it for the
    // whole local calendar day and refresh its own tournament page directly.
    $todayStart = $today->format('Y-m-d H:i:s');
    $tomorrowStart = $tomorrow->format('Y-m-d H:i:s');
    $statement = $db->prepare(
        "SELECT t.id, t.name, t.status, t.start_at, er.external_id
         FROM `{$tournaments}` t
         INNER JOIN `{$references}` er
           ON er.external_system='dartsatlas'
          AND er.external_entity_type='tournament'
          AND er.internal_entity_type='tournament'
          AND er.internal_id=t.id
         WHERE t.club_id=?
           AND t.provider_system='dartsatlas'
           AND t.start_at>=?
           AND t.start_at<?
         ORDER BY t.start_at ASC, t.id DESC
         LIMIT 1"
    );
    $statement->bind_param('iss', $clubId, $todayStart, $tomorrowStart);
    $statement->execute();
    $todayLocal = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($todayLocal !== null) {
        $externalId = (string) $todayLocal['external_id'];
        try {
            $syncTournament($externalId); // Scrape the tournament page after it leaves schedule.
        } catch (Throwable) {
            // Keep the known scheduled tournament even through a transient provider error.
        }
        $local = $localTournament((int) $todayLocal['id']) ?? $todayLocal;
        $scheduledAt = new DateTimeImmutable((string) $todayLocal['start_at'], $timezone);
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'tournament_id' => (int) $todayLocal['id'],
                'external_id' => $externalId,
                'name' => (string) ($local['name'] ?? $todayLocal['name']),
                'scheduled_at' => $scheduledAt->format(DateTimeInterface::ATOM),
                'scheduled_date' => $scheduledAt->format('Y-m-d'),
                'is_today' => true,
                'status' => (string) ($local['status'] ?? $todayLocal['status']),
                'source' => [
                    'mode' => 'scheduled_today_tournament_page',
                    'attempted_urls' => $attempted,
                    'selected_url' => 'https://www.dartsatlas.com/tournaments/' . rawurlencode($externalId),
                ],
            ],
        ]);
    }

    // 3) No current/today tournament: use schedule only for the next event.
    $scheduleCandidates = [];
    try {
        $scheduleResponse = $http->get($scheduleUrl);
        $attempted[] = ['url' => $scheduleUrl, 'status' => $scheduleResponse->status];
        $scheduleCandidates = $parseSchedule($scheduleResponse->body, $today);
    } catch (Throwable) {
        $attempted[] = ['url' => $scheduleUrl, 'status' => 'failed'];
    }

    if ($scheduleCandidates === []) {
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'tournament_id' => null,
                'external_id' => null,
                'scheduled_at' => null,
                'scheduled_date' => null,
                'is_today' => false,
                'status' => 'no_today_or_future_tournament',
                'source' => [
                    'mode' => 'none',
                    'attempted_urls' => $attempted,
                    'selected_url' => null,
                    'candidate_count' => 0,
                ],
            ],
        ]);
    }

    $selected = $scheduleCandidates[0];
    $externalId = (string) $selected['external_id'];
    $scheduledAt = $selected['scheduled_at'];
    $localId = $resolveLocalId($externalId);
    if ($localId === null) {
        // Pre-sync the tournament shell/page before start so it remains locally
        // identifiable after DartsAtlas removes it from the schedule.
        $localId = $syncTournament($externalId);
    }
    if ($localId !== null) {
        $persistSchedule($localId, $scheduledAt);
    }

    $local = $localId !== null ? $localTournament($localId) : null;
    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'tournament_id' => $localId,
            'external_id' => $externalId,
            'name' => (string) ($local['name'] ?? $selected['name']),
            'scheduled_at' => $scheduledAt->format(DateTimeInterface::ATOM),
            'scheduled_date' => $scheduledAt->format('Y-m-d'),
            'is_today' => $scheduledAt->format('Y-m-d') === $today->format('Y-m-d'),
            'status' => $localId !== null ? 'scheduled' : 'scheduled_not_synced',
            'source' => [
                'mode' => 'schedule_next',
                'attempted_urls' => $attempted,
                'selected_url' => $scheduleUrl,
                'candidate_count' => count($scheduleCandidates),
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
