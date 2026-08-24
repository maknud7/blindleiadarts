<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\DartsAtlas;

use DOMDocument;
use DOMElement;
use DOMNode;
use DOMXPath;
use InvalidArgumentException;

final class DartsAtlasParser
{
    /** @return array<string, mixed> */
    public function parseSeason(string $html, string $url): array
    {
        $players = [];
        $tournaments = [];

        foreach ($this->anchors($html) as $anchor) {
            $href = $anchor['href'];
            $label = $anchor['text'];

            $player = $this->playerFromHref($href, $label);
            if ($player !== null) {
                $players[$player['external_id']] = $player;
            }

            if (preg_match('~/tournaments/([^/?#]+)~', $href, $match)) {
                $tournaments[$match[1]] = [
                    'external_id' => $match[1],
                    'name' => $label !== '' ? $label : $match[1],
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

    /** @return array<string, mixed> */
    public function parseTournament(string $html, string $url): array
    {
        $players = [];
        $matches = [];
        $tournamentId = $this->idFromUrl($url, 'tournaments');

        foreach ($this->anchors($html) as $anchor) {
            $player = $this->playerFromHref($anchor['href'], $anchor['text']);
            if ($player !== null) {
                $players[$player['external_id']] = $player;
            }

            if (preg_match('~/matches/([^/?#]+)~', $anchor['href'], $match)) {
                $matches[$match[1]] = [
                    'external_id' => $match[1],
                    'url' => $this->absoluteUrl($anchor['href']),
                    'label' => $anchor['text'],
                ];
            }
        }

        foreach ($this->matchContainers($html) as $container) {
            $row = $this->parseMatchContainer($container, $tournamentId);
            if ($row === null) {
                continue;
            }

            foreach (['player_a', 'player_b'] as $key) {
                if (is_array($row[$key] ?? null)) {
                    $player = $row[$key];
                    $players[(string) $player['external_id']] = $player;
                }
            }

            $externalId = (string) $row['external_id'];
            $matches[$externalId] = array_merge($matches[$externalId] ?? [], $row);
        }

        return [
            'external_id' => $tournamentId,
            'name' => $this->pageTitle($html),
            'players' => array_values($players),
            'matches' => array_values($matches),
        ];
    }

    /** @return array<string, mixed> */
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

    /** @return array<string, mixed> */
    public function parseBroadcast(string $html, string $matchId): array
    {
        $state = $this->extractBroadcastState($html);
        $state['external_id'] = $matchId;
        return $state;
    }

    /** @return array<string, mixed> */
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

        $signals = [];
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

                $signals[] = $signal;
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

        $visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $html) ?? $html;
        $visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
        $state['diagnostics']['data_signals'] = array_slice($signals, 0, 50);
        $state['diagnostics']['visible_text'] = mb_substr($this->cleanText(strip_tags($visible)), 0, 2500);
        $state['players'] = array_values($state['players']);

        return $state;
    }

    /** @return array<int, DOMElement> */
    private function matchContainers(string $html): array
    {
        if (!class_exists(DOMDocument::class)) {
            return [];
        }

        $document = new DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $loaded = $document->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);

        if (!$loaded) {
            return [];
        }

        $xpath = new DOMXPath($document);
        $nodes = $xpath->query(
            '//tr[.//a[contains(@href,"/matches/") or contains(@href,"/players/") or contains(@href,"/player_stats/")]]'
            . ' | //*[(contains(concat(" ", normalize-space(@class), " "), " match ") or contains(@class,"match-row") or contains(@class,"match-card"))]'
        );

        $result = [];
        if ($nodes === false) {
            return $result;
        }

        foreach ($nodes as $node) {
            if ($node instanceof DOMElement) {
                $result[] = $node;
            }
        }

        return $result;
    }

    /** @return array<string, mixed>|null */
    private function parseMatchContainer(DOMElement $container, string $tournamentId): ?array
    {
        $document = $container->ownerDocument;
        if (!$document instanceof DOMDocument) {
            return null;
        }

        $xpath = new DOMXPath($document);
        $anchors = $xpath->query('.//a[@href]', $container);
        if ($anchors === false) {
            return null;
        }

        $players = [];
        $matchExternalId = null;
        $matchUrl = null;

        foreach ($anchors as $anchor) {
            if (!$anchor instanceof DOMElement) {
                continue;
            }

            $href = html_entity_decode($anchor->getAttribute('href'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $label = $this->cleanText($anchor->textContent);
            $player = $this->playerFromHref($href, $label);
            if ($player !== null) {
                $players[(string) $player['external_id']] = $player;
            }

            if ($matchExternalId === null && preg_match('~/matches/([^/?#]+)~', $href, $match)) {
                $matchExternalId = $match[1];
                $matchUrl = $this->absoluteUrl($href);
            }
        }

        $players = array_values($players);
        if (count($players) < 2) {
            return null;
        }

        $text = $this->cleanText($container->textContent);
        if ($matchExternalId === null) {
            $matchExternalId = 'derived-' . substr(hash('sha256', $tournamentId . '|' . $this->normaliseName($text)), 0, 24);
        }

        $scoreA = null;
        $scoreB = null;
        if (preg_match('/(?:^|\s)(\d{1,2})\s*[-–:]\s*(\d{1,2})(?:\s|$)/u', $text, $scoreMatch)) {
            $scoreA = (int) $scoreMatch[1];
            $scoreB = (int) $scoreMatch[2];
        }

        $bestOf = 3;
        if (preg_match('/best\s+of\s+(\d+)/iu', $text, $bestMatch)) {
            $bestOf = max(1, (int) $bestMatch[1]);
        }
        $legsToWin = intdiv($bestOf, 2) + 1;

        $boardNumber = null;
        if (preg_match('/(?:board|skive)\s*#?\s*(\d+)/iu', $text, $boardMatch)) {
            $boardNumber = (int) $boardMatch[1];
        }

        $roundLabel = null;
        if (preg_match('/\b(round\s+\d+|semi[- ]?final|quarter[- ]?final|final)\b/iu', $text, $roundMatch)) {
            $roundLabel = $this->cleanText($roundMatch[1]);
        }

        $averages = [];
        if (preg_match_all('/(\d{1,3}(?:[.,]\d{1,2})?)\s*avg\b/iu', $text, $avgMatches)) {
            foreach (array_slice($avgMatches[1], 0, 2) as $value) {
                $parsed = $this->asFloat($value);
                if ($parsed !== null) {
                    $averages[] = $parsed;
                }
            }
        }

        $status = 'assigned';
        if ($scoreA !== null && $scoreB !== null) {
            $status = max($scoreA, $scoreB) >= $legsToWin ? 'completed' : 'in_progress';
        } elseif (preg_match('/\b(live|in progress|playing)\b/iu', $text)) {
            $status = 'in_progress';
        }

        return [
            'external_id' => $matchExternalId,
            'url' => $matchUrl,
            'player_a' => $players[0],
            'player_b' => $players[1],
            'player_a_legs' => $scoreA,
            'player_b_legs' => $scoreB,
            'average_a' => $averages[0] ?? null,
            'average_b' => $averages[1] ?? null,
            'board_number' => $boardNumber,
            'round_label' => $roundLabel,
            'best_of_legs' => $bestOf,
            'legs_to_win' => $legsToWin,
            'status' => $status,
            'source_text' => mb_substr($text, 0, 1200),
        ];
    }

    /** @return array<int, array{href:string,text:string}> */
    private function anchors(string $html): array
    {
        $result = [];
        if (!preg_match_all('/<a\b([^>]*)>(.*?)<\/a>/isu', $html, $matches, PREG_SET_ORDER)) {
            return $result;
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

    /** @return array<string, string>|null */
    private function playerFromHref(string $href, string $label): ?array
    {
        foreach ([
            '~/seasons/[^/]+/player_stats/([^/?#]+)~',
            '~/tournaments/[^/]+/player_stats/([^/?#]+)~',
            '~/players/([^/?#]+)~',
            '~/profiles/([^/?#]+)~',
        ] as $pattern) {
            if (preg_match($pattern, $href, $match)) {
                return [
                    'external_id' => $match[1],
                    'name' => $label !== '' ? $label : $match[1],
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
