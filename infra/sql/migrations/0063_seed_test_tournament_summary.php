<?php

declare(strict_types=1);

/**
 * Seed one clearly marked, published tournament summary in TEST only.
 *
 * This is a one-off verification of the editorial summary surface. It never
 * runs against production and only selects a tournament that does not already
 * have a summary, so existing TEST editorial content is left untouched.
 */
return static function (mysqli $db, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "Skipping TEST summary seed for non-test prefix: {$prefix}" . PHP_EOL);
        return;
    }

    $clubs = $prefix . 'clubs';
    $seasons = $prefix . 'seasons';
    $tournaments = $prefix . 'tournaments';
    $summaries = $prefix . 'tournament_summaries';

    $sql = "
        SELECT
            t.id,
            t.name,
            t.start_at,
            t.status,
            s.name AS season_name
        FROM `{$tournaments}` t
        INNER JOIN `{$clubs}` c ON c.id = t.club_id
        LEFT JOIN `{$seasons}` s ON s.id = t.season_id
        LEFT JOIN `{$summaries}` ts ON ts.tournament_id = t.id
        WHERE c.slug = 'blindleia-dartklubb'
          AND ts.id IS NULL
        ORDER BY
            CASE WHEN t.status = 'completed' THEN 0 ELSE 1 END,
            COALESCE(t.end_at, t.start_at, t.created_at) DESC,
            t.id DESC
        LIMIT 1
    ";

    $result = $db->query($sql);
    $tournament = $result->fetch_assoc();
    $result->free();

    if ($tournament === null) {
        fwrite(STDOUT, "TEST summary seed skipped: no Blindleia tournament without an existing summary was found." . PHP_EOL);
        return;
    }

    $tournamentId = (int) $tournament['id'];
    $tournamentName = trim((string) $tournament['name']);
    $seasonName = trim((string) ($tournament['season_name'] ?? ''));
    $startAt = trim((string) ($tournament['start_at'] ?? ''));

    $dateLabel = '';
    if ($startAt !== '') {
        try {
            $dateLabel = (new DateTimeImmutable($startAt))->format('d.m.Y');
        } catch (Throwable) {
            $dateLabel = '';
        }
    }

    $context = $tournamentName;
    if ($dateLabel !== '') {
        $context .= ' (' . $dateLabel . ')';
    }
    if ($seasonName !== '') {
        $context .= ' i ' . $seasonName;
    }

    $title = 'TEST: Mandagsoppsummeringen flytter inn';
    $body = implode("\n\n", [
        'Dette er en test av den automatiske mandagsoppsummeringen i Blindleia Darts.',
        $context . ' får æren av å være prøvekanin. Når den virkelige mandagsjobben kjører, skal den hente fakta fra canonical data og skrive kveldens historier her – mens ELO, serietabell, kampkort og detaljstatistikk fortsatt bor i plattformens egne visninger.',
        '🎯 Her skal de viktigste historiene fra kvelden få plass: hvem som overrasket, hvem som snudde en kamp, og hvilke oppgjør som faktisk var verdt å snakke om etterpå.',
        '🏆 Finale og vinner omtales kort i tekstform. 180-ere, høy checkout og sterke averages trekkes fram når de faktisk fortjener en plass i historien – ikke som en ny statistikkvegg.',
        '😄 Og selvfølgelig blir det plass til noen «kveldens»-øyeblikk når resultatene gir oss noe å jobbe med.',
        'Denne teksten er kun TEST. Den inneholder ingen konstruerte kampresultater eller prestasjoner.'
    ]);

    $stmt = $db->prepare(
        "INSERT INTO `{$summaries}`
            (`tournament_id`, `title`, `body_text`, `status`, `published_at`, `created_by_user_account_id`, `updated_by_user_account_id`)
         VALUES (?, ?, ?, 'published', NOW(), NULL, NULL)"
    );
    $stmt->bind_param('iss', $tournamentId, $title, $body);
    $stmt->execute();
    $stmt->close();

    $verify = $db->prepare(
        "SELECT id, tournament_id, title, status, published_at
         FROM `{$summaries}`
         WHERE tournament_id = ?
         LIMIT 1"
    );
    $verify->bind_param('i', $tournamentId);
    $verify->execute();
    $saved = $verify->get_result()->fetch_assoc();
    $verify->close();

    if ($saved === null || ($saved['status'] ?? '') !== 'published') {
        throw new RuntimeException('TEST summary seed verification failed after insert.');
    }

    fwrite(
        STDOUT,
        'TEST summary published: ' . json_encode([
            'summary_id' => (int) $saved['id'],
            'tournament_id' => (int) $saved['tournament_id'],
            'tournament_name' => $tournamentName,
            'title' => (string) $saved['title'],
            'status' => (string) $saved['status'],
            'published_at' => (string) $saved['published_at'],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL
    );
};
