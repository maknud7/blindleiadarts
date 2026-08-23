<?php

declare(strict_types=1);

final class DartsAtlasParser
{
    public function parseSeason(string $html, string $seasonId): array
    {
        $dom = $this->loadDom($html);

        return [
            'external_id' => $seasonId,
            'name' => $this->firstHeading($dom) ?: 'DartsAtlas season ' . $seasonId,
            'tournament_urls' => $this->extractTournamentUrls($dom),
        ];
    }

    public function parseTournament(string $html, string $tournamentId, string $sourceUrl): array
    {
        $dom = $this->loadDom($html);
        $players = $this->extractKnownPlayers($dom);
        $matches = $this->extractMatches($dom, $tournamentId, $players);
        $text = $this->normaliseText($dom->textContent ?? '');

        $status = 'ready';
        if ($matches !== []) {
            $hasLive = false;
            $allCompleted = true;
            foreach ($matches as $match) {
                $hasLive = $hasLive || $match['status'] === 'in_progress';
                $allCompleted = $allCompleted && $match['status'] === 'completed';
            }
            if ($hasLive) {
                $status = 'in_progress';
            } elseif ($allCompleted && preg_match('/\b(Champion|Winner|Concluded|Results)\b/i', $text)) {
                $status = 'completed';
            }
        } elseif (preg_match('/\b(Concluded|Champion|Tournament complete)\b/i', $text)) {
            $status = 'completed';
        }

        return [
            'external_id' => $tournamentId,
            'name' => $this->firstHeading($dom) ?: 'DartsAtlas tournament ' . $tournamentId,
            'source_url' => $sourceUrl,
            'status' => $status,
            'subpage_urls' => $this->extractTournamentSubpageUrls($dom, $tournamentId),
            'matches' => $matches,
        ];
    }

    private function loadDom(string $html): DOMDocument
    {
        $dom = new DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $loaded = $dom->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOWARNING | LIBXML_NOERROR);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);

        if (!$loaded) {
            throw new RuntimeException('Unable to parse DartsAtlas HTML.');
        }

        return $dom;
    }

    private function firstHeading(DOMDocument $dom): ?string
    {
        $xpath = new DOMXPath($dom);
        foreach (['//h1[1]', '//main//h2[1]', '//title[1]'] as $query) {
            $node = $xpath->query($query)?->item(0);
            if ($node !== null) {
                $value = $this->normaliseText($node->textContent ?? '');
                if ($value !== '') {
                    return $value;
                }
            }
        }
        return null;
    }

    private function extractTournamentUrls(DOMDocument $dom): array
    {
        $urls = [];
        foreach ($dom->getElementsByTagName('a') as $anchor) {
            $href = trim((string)$anchor->getAttribute('href'));
            if (preg_match('~^/tournaments/([A-Za-z0-9]+)(?:$|[/?#])~', $href)) {
                $path = parse_url($href, PHP_URL_PATH) ?: $href;
                $parts = explode('/', trim($path, '/'));
                if (count($parts) === 2) {
                    $urls[$path] = true;
                }
            }
        }
        return array_keys($urls);
    }

    private function extractTournamentSubpageUrls(DOMDocument $dom, string $tournamentId): array
    {
        $urls = [];
        $prefix = '/tournaments/' . preg_quote($tournamentId, '~') . '/';
        foreach ($dom->getElementsByTagName('a') as $anchor) {
            $href = trim((string)$anchor->getAttribute('href'));
            $path = (string)(parse_url($href, PHP_URL_PATH) ?: '');
            if ($path === '' || !preg_match('~^' . $prefix . '(group|bracket|knockout|results)(?:/|$)~i', $path)) {
                continue;
            }
            $urls[$path] = true;
        }
        return array_keys($urls);
    }

    private function extractKnownPlayers(DOMDocument $dom): array
    {
        $players = [];
        foreach ($dom->getElementsByTagName('a') as $anchor) {
            $href = trim((string)$anchor->getAttribute('href'));
            $name = $this->normaliseText($anchor->textContent ?? '');
            if ($name === '') {
                continue;
            }

            $externalId = null;
            if (preg_match('~/(?:players?|profiles?|users?)/([A-Za-z0-9_-]+)(?:$|[/?#])~i', $href, $match)) {
                $externalId = $match[1];
            }

            if ($externalId === null) {
                continue;
            }

            $players[$externalId] = [
                'external_id' => $externalId,
                'name' => $name,
                'href' => $href,
            ];
        }
        return array_values($players);
    }

    private function extractMatches(DOMDocument $dom, string $tournamentId, array $knownPlayers): array
    {
        $xpath = new DOMXPath($dom);
        $nodes = $xpath->query('//*[self::li or self::tr or self::article or self::section or self::div][contains(normalize-space(.), "Best of")]');
        if ($nodes === false) {
            return [];
        }

        $matches = [];
        $seen = [];

        foreach ($nodes as $node) {
            $text = $this->normaliseText($node->textContent ?? '');
            if ($text === '' || strlen($text) > 900 || !preg_match('/\bBest\s+of\s+(\d+)\b/i', $text, $bestOfMatch)) {
                continue;
            }

            // Avoid parsing a parent container that contains several match rows.
            $nestedBestOf = 0;
            foreach ($node->childNodes as $child) {
                if ($child instanceof DOMElement && stripos($this->normaliseText($child->textContent ?? ''), 'Best of') !== false) {
                    $nestedBestOf++;
                }
            }
            if ($nestedBestOf > 1) {
                continue;
            }

            $players = $this->playersInNode($node, $knownPlayers, $text);
            if (count($players) < 2) {
                continue;
            }
            $players = array_slice($players, 0, 2);

            $bestOf = max(1, (int)$bestOfMatch[1]);
            $round = $this->extractRound($text);
            $board = $this->extractBoard($text);
            [$scoreA, $scoreB] = $this->extractScores($text, $players[0]['name'], $players[1]['name']);
            $averages = $this->extractAverages($text);

            $externalMatchId = $this->matchIdFromNode($node);
            if ($externalMatchId === null) {
                $identityA = $players[0]['external_id'] ?: $this->normaliseName($players[0]['name']);
                $identityB = $players[1]['external_id'] ?: $this->normaliseName($players[1]['name']);
                $externalMatchId = 'derived-' . substr(hash('sha256', implode('|', [
                    $tournamentId,
                    $round ?? '',
                    (string)($board ?? ''),
                    $identityA,
                    $identityB,
                ])), 0, 32);
            }

            if (isset($seen[$externalMatchId])) {
                continue;
            }
            $seen[$externalMatchId] = true;

            $legsToWin = intdiv($bestOf, 2) + 1;
            $status = 'pending';
            $winnerExternalId = null;
            if ($scoreA >= $legsToWin || $scoreB >= $legsToWin) {
                $status = 'completed';
                $winnerExternalId = $scoreA > $scoreB ? $players[0]['external_id'] : $players[1]['external_id'];
            } elseif (($scoreA + $scoreB) > 0 || $board !== null) {
                $status = 'in_progress';
            }

            $matches[] = [
                'external_id' => $externalMatchId,
                'round_label' => $round,
                'board_number' => $board,
                'best_of_legs' => $bestOf,
                'legs_to_win' => $legsToWin,
                'status' => $status,
                'player_a' => $players[0],
                'player_b' => $players[1],
                'legs_won_a' => $scoreA,
                'legs_won_b' => $scoreB,
                'winner_external_id' => $winnerExternalId,
                'average_a' => $averages[0] ?? null,
                'average_b' => $averages[1] ?? null,
                'raw_text' => $text,
            ];
        }

        return $matches;
    }

    private function playersInNode(DOMNode $node, array $knownPlayers, string $text): array
    {
        $found = [];
        if ($node instanceof DOMElement) {
            foreach ($node->getElementsByTagName('a') as $anchor) {
                $href = trim((string)$anchor->getAttribute('href'));
                $name = $this->normaliseText($anchor->textContent ?? '');
                if ($name === '') {
                    continue;
                }
                if (preg_match('~/(?:players?|profiles?|users?)/([A-Za-z0-9_-]+)(?:$|[/?#])~i', $href, $match)) {
                    $found[$match[1]] = [
                        'external_id' => $match[1],
                        'name' => $name,
                        'href' => $href,
                    ];
                }
            }
        }

        if (count($found) >= 2) {
            return array_values($found);
        }

        $byPosition = [];
        foreach ($knownPlayers as $player) {
            $position = mb_stripos($text, $player['name']);
            if ($position !== false) {
                $byPosition[] = ['position' => $position, 'player' => $player];
            }
        }
        usort($byPosition, static fn(array $a, array $b): int => $a['position'] <=> $b['position']);
        foreach ($byPosition as $item) {
            $found[$item['player']['external_id']] = $item['player'];
        }

        return array_values($found);
    }

    private function matchIdFromNode(DOMNode $node): ?string
    {
        if (!($node instanceof DOMElement)) {
            return null;
        }
        foreach ($node->getElementsByTagName('a') as $anchor) {
            $href = trim((string)$anchor->getAttribute('href'));
            if (preg_match('~/matches?/([A-Za-z0-9_-]+)(?:$|[/?#])~i', $href, $match)) {
                return $match[1];
            }
        }
        return null;
    }

    private function extractRound(string $text): ?string
    {
        if (preg_match('/\b(Round\s+\d+|Last\s+\d+|Quarter[- ]?Final|Semi[- ]?Final|Final)\b/i', $text, $match)) {
            return trim($match[1]);
        }
        return null;
    }

    private function extractBoard(string $text): ?int
    {
        if (preg_match('/\bBoard\s+(\d+)\b/i', $text, $match)) {
            return (int)$match[1];
        }
        return null;
    }

    private function extractScores(string $text, string $nameA, string $nameB): array
    {
        $posA = mb_stripos($text, $nameA);
        $posB = mb_stripos($text, $nameB);
        if ($posA === false || $posB === false || $posB <= $posA) {
            return [0, 0];
        }

        $afterA = mb_substr($text, $posA + mb_strlen($nameA), $posB - ($posA + mb_strlen($nameA)));
        $afterB = mb_substr($text, $posB + mb_strlen($nameB));

        $scoreA = preg_match('/\b(\d{1,2})\b/', $afterA, $a) ? (int)$a[1] : 0;
        $scoreB = preg_match('/^\s*(\d{1,2})\b/', $afterB, $b) ? (int)$b[1] : 0;

        return [$scoreA, $scoreB];
    }

    private function extractAverages(string $text): array
    {
        preg_match_all('/\b(\d{1,3}(?:\.\d{1,2})?)\s*Avg\b/i', $text, $matches);
        return array_map('floatval', array_slice($matches[1] ?? [], 0, 2));
    }

    private function normaliseText(string $text): string
    {
        return trim((string)preg_replace('/\s+/u', ' ', html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8')));
    }

    private function normaliseName(string $name): string
    {
        $name = mb_strtolower($this->normaliseText($name));
        $transliterated = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name);
        if ($transliterated !== false) {
            $name = $transliterated;
        }
        return trim((string)preg_replace('/[^a-z0-9]+/', ' ', $name));
    }
}
