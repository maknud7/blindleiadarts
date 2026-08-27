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
    private EloLedgerService $elo;
    private PlayoffReconciliationService $playoffs;
    private LinearRankingService $linearRanking;

    public function __construct(
        Database $database,
        private readonly ?Config $config = null
    ) {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->scoring = new MatchScoringRepository($database);
        $this->elo = new EloLedgerService($database);
        $this->playoffs = new PlayoffReconciliationService($database);
        $this->linearRanking = new LinearRankingService($database);
    }

    public function startMatch(int $kioskId, string $source = 'manual'): void
    {
        $before = $this->startState($kioskId);
        $this->scoring->startMatch($kioskId);

        // startMatch is intentionally idempotent. Scolia may call it while a visit
        // is being assembled, so only reconcile/publish when it actually starts a
        // match or opens a new leg.
        if ($before === null || ((string) $before['status'] === 'in_progress' && (int) $before['has_open_leg'] === 1)) {
            return;
        }

        $matchId = (int) $before['id'];
        $this->playoffs->afterMutation($matchId, false);
        $this->publishRefresh($kioskId, $matchId, $source, 'match_started');
    }

    /** @param array<string,mixed> $payload */
    public function recordVisit(int $kioskId, array $payload, string $source = 'manual'): void
    {
        $matchId = $this->playoffs->targetMatchIdForKiosk($kioskId, false);
        $this->scoring->recordVisit($kioskId, $payload);

        // ELO is a match result, never live match state. It is therefore applied
        // only after the canonical match has actually reached completed status.
        if ($matchId !== null && $this->matchIsCompleted($matchId)) {
            $this->elo->applyCompletedMatch($matchId);
        }

        // Playoff reconciliation can complete the whole tournament. Linear season
        // points are therefore reconciled only after the bracket lifecycle is current.
        $this->playoffs->afterMutation($matchId, false);
        $this->linearRanking->reconcileByMatchId($matchId);
        $this->publishRefresh($kioskId, $matchId, $source, 'visit_recorded');
    }

    public function undoLastVisit(int $kioskId, string $source = 'manual'): void
    {
        $matchId = $this->playoffs->assertUndoAllowed($kioskId);
        $this->scoring->undoLastVisit($kioskId);

        // If the undo reopens a previously completed match, remove its already
        // applied ELO result. No new ELO is calculated until the match completes again.
        if ($matchId !== null) {
            $this->elo->revertMatch($matchId);
        }

        $this->playoffs->afterMutation($matchId, true);
        $this->linearRanking->reconcileByMatchId($matchId);
        $this->publishRefresh($kioskId, $matchId, $source, 'visit_undone');
    }

    /** @return array{id:int,status:string,has_open_leg:int}|null */
    private function startState(int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.status,
                    EXISTS(
                        SELECT 1 FROM `%1$slegs` l
                        WHERE l.match_id=m.id AND l.status IN ("pending","in_progress")
                    ) AS has_open_leg
             FROM `%1$smatches` m
             WHERE m.kiosk_id=? AND m.status IN ("in_progress","assigned")
             ORDER BY FIELD(m.status,"in_progress","assigned"), m.id ASC
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            return null;
        }
        return [
            'id' => (int) $row['id'],
            'status' => (string) $row['status'],
            'has_open_leg' => (int) $row['has_open_leg'],
        ];
    }

    private function matchIsCompleted(int $matchId): bool
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT status FROM `%1$smatches` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row !== null && (string) ($row['status'] ?? '') === 'completed';
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
