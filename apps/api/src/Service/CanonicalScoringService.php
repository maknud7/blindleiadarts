<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\MatchScoringRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

/**
 * Single mutation boundary for canonical match scoring.
 *
 * Scoring sources (manual kiosk, Scolia and future adapters) normalize their
 * input before reaching this service. From here on, the same match rules,
 * projections and realtime refresh path are always used.
 */
final class CanonicalScoringService
{
    private mysqli $connection;
    private string $tablePrefix;
    private MatchScoringRepository $scoring;
    private EloReconciliationService $elo;
    private PlayoffReconciliationService $playoffs;

    public function __construct(
        Database $database,
        private readonly ?Config $config = null
    ) {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->scoring = new MatchScoringRepository($database);
        $this->elo = new EloReconciliationService($database);
        $this->playoffs = new PlayoffReconciliationService($database);
    }

    public function startMatch(int $kioskId, string $source = 'manual'): void
    {
        $matchId = $this->playoffs->targetMatchIdForKiosk($kioskId, false);
        $this->scoring->startMatch($kioskId);
        $this->afterMutation($kioskId, $matchId, false, $source, 'match_started');
    }

    /** @param array<string,mixed> $payload */
    public function recordVisit(int $kioskId, array $payload, string $source = 'manual'): void
    {
        $matchId = $this->playoffs->targetMatchIdForKiosk($kioskId, false);
        $this->scoring->recordVisit($kioskId, $payload);
        $this->afterMutation($kioskId, $matchId, false, $source, 'visit_recorded');
    }

    public function undoLastVisit(int $kioskId, string $source = 'manual'): void
    {
        $matchId = $this->playoffs->assertUndoAllowed($kioskId);
        $this->scoring->undoLastVisit($kioskId);
        $this->afterMutation($kioskId, $matchId, true, $source, 'visit_undone');
    }

    private function afterMutation(
        int $kioskId,
        ?int $matchId,
        bool $wasUndo,
        string $source,
        string $reason
    ): void {
        // All derived competition state is reconciled from canonical match state.
        $this->elo->reconcileKiosk($kioskId);
        $this->playoffs->afterMutation($matchId, $wasUndo);
        $this->publishRefresh($kioskId, $matchId, $source, $reason);
    }

    private function publishRefresh(int $kioskId, ?int $matchId, string $source, string $reason): void
    {
        if ($this->config === null || !$this->config->realtimePublishEnabled()) {
            return;
        }

        $sql = sprintf(
            'SELECT code, club_id FROM `%1$skiosks` WHERE id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            return;
        }

        $channels = [];
        $code = trim((string) ($row['code'] ?? ''));
        $clubId = (int) ($row['club_id'] ?? 0);
        if ($code !== '') {
            $channels[] = 'kiosk:' . $code;
        }
        if ($clubId > 0) {
            $channels[] = 'club:' . $clubId;
        }
        if ($channels === []) {
            return;
        }

        $this->publish($channels, [
            'refresh' => true,
            'reason' => $reason,
            'source' => $this->normalizeSource($source),
            'kiosk_id' => $kioskId,
            'match_id' => $matchId,
        ]);
    }

    /** @param array<int,string> $channels @param array<string,mixed> $payload */
    private function publish(array $channels, array $payload): void
    {
        if ($this->config === null) {
            return;
        }

        $body = json_encode([
            'secret' => $this->config->realtimePublishSecret(),
            'channels' => $channels,
            'event' => 'snapshot',
            'payload' => $payload,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($body === false) {
            return;
        }

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\nConnection: close",
                'content' => $body,
                'timeout' => 1.5,
                'ignore_errors' => true,
            ],
        ]);

        try {
            @file_get_contents($this->config->realtimePublishUrl(), false, $context);
        } catch (Throwable) {
            // Realtime is best effort and must never break canonical scoring.
        }
    }

    private function normalizeSource(string $source): string
    {
        $source = strtolower(trim($source));
        return in_array($source, ['manual', 'scolia', 'import', 'api'], true)
            ? $source
            : 'api';
    }
}
