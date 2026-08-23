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
                $tournaments[$match[1]] = [
                    'external_id' => $match[1],
                    'name' => $label,
                    'url' => $this->absoluteUrl($href),
                ];
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

        return [
            'external_id' => $this->idFromUrl($url, 'tournaments'),
            'name' => $this->pageTitle($html),
            'players' => array_values($players),
            'matches' => array_values($matches),
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
        $state['diagnostics']['visible_text'] = mb_substr($this->cleanText(strip_tags($visible)), 0, 4000);
        $state['players'] = array_values($state['players']);

        return $state;
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
            '~/players/([^/?#]+)~',
            '~/profiles/([^/?#]+)~',
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
