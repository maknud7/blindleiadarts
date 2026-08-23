<?php

declare(strict_types=1);

final class DartsAtlasHtmlParser
{
    public function parseSeason(string $html, string $url): array
    {
        $players = [];
        $tournaments = [];
        foreach ($this->anchors($html) as $anchor) {
            $href = $anchor['href'];
            $label = $anchor['text'];

            if (preg_match('~/seasons/[^/]+/player_stats/([^/?#]+)~', $href, $match)) {
                $players[$match[1]] = [
                    'external_id' => $match[1],
                    'name' => $label,
                    'url' => $this->absoluteUrl($href),
                ];
            }

            if (preg_match('~/tournaments/([^/?#]+)~', $href, $match)) {
                $path = parse_url($href, PHP_URL_PATH) ?: $href;
                if (count(explode('/', trim((string) $path, '/'))) === 2) {
                    $tournaments[$match[1]] = [
                        'external_id' => $match[1],
                        'name' => $label,
                        'url' => $this->absoluteUrl($href),
                    ];
                }
            }
        }

        return [
            'external_id' => $this->idFromUrl($url, 'seasons'),
            'name' => $this->pageTitle($html),
            'players' => array_values($players),
            'tournaments' => array_values($tournaments),
        ];
    }

    public function parseTournament(string $html, string $url): array
    {
        $tournamentId = $this->idFromUrl($url, 'tournaments');
        $matches = [];
        $players = [];

        foreach ($this->anchors($html) as $anchor) {
            $href = $anchor['href'];
            if (preg_match('~/matches/([^/?#]+)~', $href, $match)) {
                $matches[$match[1]] = [
                    'external_id' => $match[1],
                    'url' => $this->absoluteUrl($href),
                    'label' => $anchor['text'],
                ];
            }

            $player = $this->playerFromHref($href, $anchor['text']);
            if ($player !== null) {
                $players[$player['external_id']] = $player;
            }
        }

        foreach ($this->matchRows($html, $tournamentId, array_values($players)) as $row) {
            $externalId = (string) $row['external_id'];
            $matches[$externalId] = array_merge($matches[$externalId] ?? [], $row);
            foreach (['player_a', 'player_b'] as $key) {
                if (isset($row[$key]['external_id'], $row[$key]['name'])) {
                    $players[(string) $row[$key]['external_id']] = $row[$key];
                }
            }
        }

        return [
            'external_id' => $tournamentId,
            'name' => $this->pageTitle($html),
            'players' => array_values($players),
            'matches' => array_values($matches),
            'subpages' => $this->tournamentSubpages($html, $tournamentId),
        ];
    }

    public function parseMatch(string $html, string $url): array
    {
        $players = [];
        foreach ($this->anchors($html) as $anchor) {
            $player = $this->playerFromHref($anchor['href'], $anchor['text']);
            if ($player !== null) {
                $players[$player['external_id']] = $player;
            }
        }

        return [
            'external_id' => $this->idFromUrl($url, 'matches'),
            'name' => $this->pageTitle($html),
            'players' => array_values($players),
            'live' => $this->extractBroadcastState($html),
        ];
    }

    public function parseBroadcast(string $html, string $matchId): array
    {
        $state = $this->extractBroadcastState($html);
        $state['external_id'] = $matchId;
        return $state;
    }

    private function matchRows(string $html, string $tournamentId, array $knownPlayers): array
    {
        if (!class_exists(DOMDocument::class)) {
            return [];
        }

        $dom = new DOMDocument();
        $old = libxml_use_internal_errors(true);
        $loaded = $dom->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOWARNING | LIBXML_NOERROR);
        libxml_clear_errors();
        libxml_use_internal_errors($old);
        if (!$loaded) {
            return [];
        }

        $xpath = new DOMXPath($dom);
        $nodes = $xpath->query('//*[self::li or self::tr or self::article or self::section or self::div][contains(normalize-space(.), "Best of")]');
        if ($nodes === false) {
            return [];
        }

        $rows = [];
        foreach ($nodes as $node) {
            $text = $this->cleanText($node->textContent ?? '');
            if ($text === '' || mb_strlen($text) > 900 || !preg_match('/\bBest\s+of\s+(\d+)\b/i', $text, $bestMatch)) {
                continue;
            }

            $nested = 0;
            foreach ($node->childNodes as $child) {
                if ($child instanceof DOMElement && stripos($this->cleanText($child->textContent ?? ''), 'Best of') !== false) {
                    $nested++;
                }
            }
            if ($nested > 1) {
                continue;
            }

            $nodePlayers = $this->playersInNode($node, $knownPlayers, $text);
            if (count($nodePlayers) < 2) {
                continue;
            }
            $nodePlayers = array_slice($nodePlayers, 0, 2);

            $matchId = $this->matchIdInNode($node);
            $round = $this->roundFromText($text);
            $board = $this->boardFromText($text);
            [$scoreA, $scoreB] = $this->scoresFromText($text, $nodePlayers[0]['name'], $nodePlayers[1]['name']);
            $averages = $this->averagesFromText($text);
            $bestOf = max(1, (int) $bestMatch[1]);
            $legsToWin = intdiv($bestOf, 2) + 1;

            if ($matchId === null) {
                $matchId = 'derived-' . substr(hash('sha256', implode('|', [
                    $tournamentId,
                    $round ?? '',
                    (string) ($board ?? ''),
                    (string) ($nodePlayers[0]['external_id'] ?? $this->normaliseName($nodePlayers[0]['name'])),
                    (string) ($nodePlayers[1]['external_id'] ?? $this->normaliseName($nodePlayers[1]['name'])),
                ])), 0, 32);
            }

            $status = 'pending';
            if ($scoreA >= $legsToWin || $scoreB >= $legsToWin) {
                $status = 'completed';
            } elseif (($scoreA + $scoreB) > 0 || $board !== null) {
                $status = 'in_progress';
            }

            $rows[$matchId] = [
                'external_id' => $matchId,
                'url' => str_starts_with($matchId, 'derived-') ? null : $this->absoluteUrl('/matches/' . $matchId),
                'round_label' => $round,
                'board_number' => $board,
                'best_of_legs' => $bestOf,
                'legs_to_win' => $legsToWin,
                'status' => $status,
                'player_a' => $nodePlayers[0],
                'player_b' => $nodePlayers[1],
                'player_a_legs' => $scoreA,
                'player_b_legs' => $scoreB,
                'average_a' => $averages[0] ?? null,
                'average_b' => $averages[1] ?? null,
                'raw_text' => $text,
            ];
        }

        return array_values($rows);
    }

    private function extractBroadcastState(string $html): array
    {
        $state = [
            'players' => [],
            'diagnostics' => [],
        ];

        $attributes = [
            'player-id', 'player-name', 'score', 'legs', 'average', 'first-nine-average',
            'darts-thrown', 'checkout-hits', 'checkout-attempts', 'highest-checkout',
            'score-100-plus', 'score-140-plus', 'score-180',
        ];

        $dataSignals = [];
        if (preg_match_all('/<[^>]+(?:data-player-id|data-player-name|data-score|data-legs|data-average)[^>]*>/iu', $html, $tags)) {
            foreach ($tags[0] as $tag) {
                $signal = [];
                foreach ($attributes as $attribute) {
                    $value = $this->attribute($tag, 'data-' . $attribute);
                    if ($value !== null && $value !== '') {
                        $signal[$attribute] = $value;
                    }
                }
                if ($signal === []) {
                    continue;
                }

                $dataSignals[] = $signal;
                if (!isset($signal['player-id']) && !isset($signal['player-name'])) {
                    continue;
                }

                $key = $signal['player-id'] ?? $this->normaliseName((string) $signal['player-name']);
                $entry = $state['players'][$key] ?? [
                    'external_id' => $signal['player-id'] ?? null,
                    'name' => $signal['player-name'] ?? null,
                ];

                if (isset($signal['player-id'])) {
                    $entry['external_id'] = $signal['player-id'];
                }
                if (isset($signal['player-name'])) {
                    $entry['name'] = $signal['player-name'];
                }

                foreach ([
                    'score', 'legs', 'darts-thrown', 'checkout-hits', 'checkout-attempts',
                    'highest-checkout', 'score-100-plus', 'score-140-plus', 'score-180',
                ] as $field) {
                    if (isset($signal[$field]) && ($value = $this->asInt($signal[$field])) !== null) {
                        $entry[str_replace('-', '_', $field)] = $value;
                    }
                }
                foreach (['average', 'first-nine-average'] as $field) {
                    if (isset($signal[$field]) && ($value = $this->asFloat($signal[$field])) !== null) {
                        $entry[str_replace('-', '_', $field)] = $value;
                    }
                }

                $state['players'][$key] = $entry;
            }
        }
        $state['diagnostics']['data_signals'] = array_slice($dataSignals, 0, 80);

        $classSignals = [];
        if (preg_match_all('/<([a-z0-9]+)([^>]*class=(?:"[^"]*(?:player|score|leg|avg|average)[^"]*"|\'[^\']*(?:player|score|leg|avg|average)[^\']*\')[^>]*)>(.*?)<\/\1>/isu', $html, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $class = $this->attribute($match[2], 'class') ?? '';
                $text = $this->cleanText(strip_tags($match[3]));
                if ($text === '' || mb_strlen($text) > 180) {
                    continue;
                }
                $classSignals[] = ['class' => $class, 'text' => $text];
            }
        }
        $state['diagnostics']['class_signals'] = array_slice($classSignals, 0, 80);

        $visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $html) ?? $html;
        $visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
        $visibleText = $this->cleanText(strip_tags($visible));
        $state['diagnostics']['visible_text'] = mb_substr($visibleText, 0, 4000);

        $state['players'] = array_values($state['players']);
        return $state;
    }

    private function playersInNode(DOMNode $node, array $knownPlayers, string $text): array
    {
        $found = [];
        if ($node instanceof DOMElement) {
            foreach ($node->getElementsByTagName('a') as $anchor) {
                $player = $this->playerFromHref((string) $anchor->getAttribute('href'), $this->cleanText($anchor->textContent ?? ''));
                if ($player !== null) {
                    $found[$player['external_id']] = $player;
                }
            }
        }
        if (count($found) >= 2) {
            return array_values($found);
        }

        $positioned = [];
        foreach ($knownPlayers as $player) {
            $position = mb_stripos($text, (string) $player['name']);
            if ($position !== false) {
                $positioned[] = ['position' => $position, 'player' => $player];
            }
        }
        usort($positioned, static fn(array $a, array $b): int => $a['position'] <=> $b['position']);
        foreach ($positioned as $item) {
            $found[(string) $item['player']['external_id']] = $item['player'];
        }
        return array_values($found);
    }

    private function matchIdInNode(DOMNode $node): ?string
    {
        if (!($node instanceof DOMElement)) {
            return null;
        }
        foreach ($node->getElementsByTagName('a') as $anchor) {
            if (preg_match('~/matches/([^/?#]+)~', (string) $anchor->getAttribute('href'), $match)) {
                return $match[1];
            }
        }
        return null;
    }

    private function roundFromText(string $text): ?string
    {
        if (preg_match('/\b(Round\s+\d+|Last\s+\d+|Quarter[- ]?Final|Semi[- ]?Final|Final)\b/i', $text, $match)) {
            return trim($match[1]);
        }
        return null;
    }

    private function boardFromText(string $text): ?int
    {
        return preg_match('/\bBoard\s+(\d+)\b/i', $text, $match) ? (int) $match[1] : null;
    }

    private function scoresFromText(string $text, string $nameA, string $nameB): array
    {
        $posA = mb_stripos($text, $nameA);
        $posB = mb_stripos($text, $nameB);
        if ($posA === false || $posB === false || $posB <= $posA) {
            return [0, 0];
        }
        $afterA = mb_substr($text, $posA + mb_strlen($nameA), $posB - ($posA + mb_strlen($nameA)));
        $afterB = mb_substr($text, $posB + mb_strlen($nameB));
        $scoreA = preg_match('/\b(\d{1,2})\b/', $afterA, $a) ? (int) $a[1] : 0;
        $scoreB = preg_match('/^\s*(\d{1,2})\b/', $afterB, $b) ? (int) $b[1] : 0;
        return [$scoreA, $scoreB];
    }

    private function averagesFromText(string $text): array
    {
        preg_match_all('/\b(\d{1,3}(?:\.\d{1,2})?)\s*Avg\b/i', $text, $matches);
        return array_map('floatval', array_slice($matches[1] ?? [], 0, 2));
    }

    private function tournamentSubpages(string $html, string $tournamentId): array
    {
        $result = [];
        foreach ($this->anchors($html) as $anchor) {
            $path = (string) (parse_url($anchor['href'], PHP_URL_PATH) ?: '');
            if (preg_match('~^/tournaments/' . preg_quote($tournamentId, '~') . '/(group|bracket|knockout|results)(?:/|$)~i', $path)) {
                $result[$path] = $this->absoluteUrl($path);
            }
        }
        return array_values($result);
    }

    private function anchors(string $html): array
    {
        $result = [];
        if (!preg_match_all('/<a\b([^>]*)>(.*?)<\/a>/isu', $html, $matches, PREG_SET_ORDER)) {
            return [];
        }

        foreach ($matches as $match) {
            $href = $this->attribute($match[1], 'href');
            if ($href === null || $href === '') {
                continue;
            }
            $result[] = [
                'href' => html_entity_decode($href, ENT_QUOTES | ENT_HTML5, 'UTF-8'),
                'text' => $this->cleanText(strip_tags($match[2])),
            ];
        }

        return $result;
    }

    private function attribute(string $tag, string $name): ?string
    {
        $quoted = preg_quote($name, '/');
        if (preg_match('/\b' . $quoted . '\s*=\s*(["\'])(.*?)\1/isu', $tag, $match)) {
            return html_entity_decode(trim($match[2]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
        if (preg_match('/\b' . $quoted . '\s*=\s*([^\s>]+)/iu', $tag, $match)) {
            return html_entity_decode(trim($match[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
        return null;
    }

    private function pageTitle(string $html): string
    {
        foreach (['h1', 'h2', 'title'] as $tag) {
            if (preg_match('/<' . $tag . '\b[^>]*>(.*?)<\/' . $tag . '>/isu', $html, $match)) {
                $value = $this->cleanText(strip_tags($match[1]));
                if ($value !== '') {
                    return $value;
                }
            }
        }
        return 'DartsAtlas';
    }

    private function playerFromHref(string $href, string $label): ?array
    {
        foreach ([
            '~/seasons/[^/]+/player_stats/([^/?#]+)~',
            '~/tournaments/[^/]+/player_stats/([^/?#]+)~',
            '~/players/([^/?#]+)~',
            '~/profiles/([^/?#]+)~',
            '~/users/([^/?#]+)~',
        ] as $pattern) {
            if (preg_match($pattern, $href, $match)) {
                return [
                    'external_id' => $match[1],
                    'name' => $label,
                    'url' => $this->absoluteUrl($href),
                ];
            }
        }
        return null;
    }

    private function absoluteUrl(string $href): string
    {
        if (preg_match('~^https://(www\.)?dartsatlas\.com/~i', $href)) {
            return $href;
        }
        return 'https://www.dartsatlas.com/' . ltrim($href, '/');
    }

    private function idFromUrl(string $url, string $resource): string
    {
        if (!preg_match('~/' . preg_quote($resource, '~') . '/([^/?#]+)~', $url, $match)) {
            throw new InvalidArgumentException("Could not find {$resource} id in URL: {$url}");
        }
        return $match[1];
    }

    private function cleanText(string $value): string
    {
        $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim((string) preg_replace('/\s+/u', ' ', $value));
    }

    private function normaliseName(string $value): string
    {
        $value = mb_strtolower($this->cleanText($value), 'UTF-8');
        $value = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?? $value;
        return trim((string) preg_replace('/\s+/u', ' ', $value));
    }

    private function asInt(string $value): ?int
    {
        $value = trim($value);
        return preg_match('/^-?\d+$/', $value) ? (int) $value : null;
    }

    private function asFloat(string $value): ?float
    {
        $value = str_replace(',', '.', trim($value));
        return is_numeric($value) ? (float) $value : null;
    }
}
