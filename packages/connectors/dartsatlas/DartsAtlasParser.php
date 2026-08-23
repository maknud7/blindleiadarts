<?php

declare(strict_types=1);

final class DartsAtlasParser
{
    /** @return list<string> */
    public function extractTournamentIds(string $html): array { return $this->extractIds($html, 'tournaments'); }
    /** @return list<string> */
    public function extractSeasonIds(string $html): array { return $this->extractIds($html, 'seasons'); }
    /** @return list<string> */
    public function extractMatchIds(string $html): array { return $this->extractIds($html, 'matches'); }

    /** @return list<array{id:string,name:string}> */
    public function extractPlayers(string $html): array
    {
        if ($html === '') return [];
        preg_match_all(
            '~<a\b[^>]*href\s*=\s*(["\'])(?:https?://(?:www\.)?dartsatlas\.com)?/players/([A-Za-z0-9_-]+)[^"\']*\1[^>]*>(.*?)</a>~isu',
            $html,
            $matches,
            PREG_SET_ORDER
        );
        $players = [];
        foreach ($matches as $match) {
            $name = $this->clean((string) ($match[3] ?? ''));
            if ($name !== '') {
                $id = (string) $match[2];
                $players[$id] = ['id' => $id, 'name' => $name];
            }
        }
        return array_values($players);
    }

    public function extractTitle(string $html): ?string
    {
        foreach (['h1', 'h2', 'title'] as $tag) {
            if (preg_match('~<' . $tag . '\b[^>]*>(.*?)</' . $tag . '>~isu', $html, $match)) {
                $text = $this->clean((string) $match[1]);
                if ($text !== '') {
                    return preg_replace('/\s+\|\s+Darts Atlas$/i', '', $text) ?: $text;
                }
            }
        }
        return null;
    }

    public function extractTournamentStartAt(string $html): ?DateTimeImmutable
    {
        $text = $this->visibleText($html);
        $patterns = [
            '/\b(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*[·\-]\s*(\d{1,2}:\d{2})\b/u',
            '/\b([A-Za-z]+\s+\d{1,2},\s+\d{4})\s*[·\-]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/iu',
        ];
        foreach ($patterns as $pattern) {
            if (!preg_match($pattern, $text, $match)) continue;
            try {
                return new DateTimeImmutable(trim($match[1] . ' ' . $match[2]), new DateTimeZone('Europe/Oslo'));
            } catch (Throwable) {
            }
        }
        return null;
    }

    /** @return array<string,mixed> */
    public function extractLiveSnapshot(string $baseHtml, string $statsHtml = '', string $summaryHtml = ''): array
    {
        $base = $this->visibleText($baseHtml);
        $stats = $this->visibleText($statsHtml);
        $summary = $this->visibleText($summaryHtml);
        $combined = trim($base . ' ' . $stats . ' ' . $summary);

        $status = 'unknown';
        if ($summary !== '' && preg_match('/\b(?:winner|match summary|completed|final score)\b/i', $summary)) {
            $status = 'completed';
        } elseif (preg_match('/\b(?:live|in progress|throw|remaining|leg)\b/i', $stats)) {
            $status = 'live';
        } elseif ($base !== '') {
            $status = 'pending';
        }

        $board = null;
        if (preg_match('/\bBoard\s*#?\s*([A-Za-z0-9-]+)\b/i', $combined, $m)) $board = 'Board ' . $m[1];
        $averages = $this->labelValues($combined, 'Average');
        $first9 = $this->labelValues($combined, 'First\\s*9');
        [$aLegs, $bLegs] = $this->twoValueScore($stats);
        [$aRemaining, $bRemaining] = $this->remaining($stats);

        return [
            'status' => $status,
            'board_label' => $board,
            'player_a_legs' => $aLegs,
            'player_b_legs' => $bLegs,
            'player_a_remaining' => $aRemaining,
            'player_b_remaining' => $bRemaining,
            'player_a_average' => $averages[0] ?? null,
            'player_b_average' => $averages[1] ?? null,
            'player_a_first9' => $first9[0] ?? null,
            'player_b_first9' => $first9[1] ?? null,
            'stats' => ['raw_labels' => ['averages' => $averages, 'first9' => $first9]],
        ];
    }

    public function visibleText(string $html): string
    {
        if ($html === '') return '';
        $html = preg_replace('~<(script|style|noscript)\b[^>]*>.*?</\1>~isu', ' ', $html) ?? $html;
        return $this->clean($html);
    }

    /** @return list<string> */
    private function extractIds(string $html, string $entity): array
    {
        $pattern = sprintf('~(?:https?://(?:www\.)?dartsatlas\.com)?/%s/([A-Za-z0-9_-]+)~i', preg_quote($entity, '~'));
        preg_match_all($pattern, $html, $matches);
        $ids = array_values(array_unique(array_map('strval', $matches[1] ?? [])));
        return array_values(array_filter($ids, static fn(string $id): bool => $id !== ''));
    }

    private function clean(string $html): string
    {
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
    }

    /** @return list<float> */
    private function labelValues(string $text, string $label): array
    {
        preg_match_all('/\b' . $label . '\s*:?\s*(\d{1,3}(?:\.\d{1,2})?)\b/iu', $text, $matches);
        return array_values(array_slice(array_map('floatval', $matches[1] ?? []), 0, 2));
    }

    /** @return array{0:?int,1:?int} */
    private function twoValueScore(string $text): array
    {
        $patterns = [
            '/\bLegs?\s*:?\s*(\d+)\s*[-–:]\s*(\d+)\b/i',
            '/\b(\d+)\s*[-–:]\s*(\d+)\s*Legs?\b/i',
        ];
        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $text, $m)) return [(int) $m[1], (int) $m[2]];
        }
        return [null, null];
    }

    /** @return array{0:?int,1:?int} */
    private function remaining(string $text): array
    {
        preg_match_all('/\b(?:remaining|left)\s*:?\s*(\d{1,3})\b/iu', $text, $matches);
        $v = array_map('intval', $matches[1] ?? []);
        return [$v[0] ?? null, $v[1] ?? null];
    }
}
