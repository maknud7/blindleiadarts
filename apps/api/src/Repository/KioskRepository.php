<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class KioskRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findKioskStateByCode(string $kioskCode, ?string $pairingToken = null): ?array
    {
        $kiosk = $this->requireKioskAccessByCode($kioskCode, $pairingToken);

        if ($kiosk === null) {
            return null;
        }

        return $this->buildKioskState($kiosk);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function startAssignedMatchByCode(string $kioskCode, ?string $pairingToken = null): ?array
    {
        $kiosk = $this->requireKioskAccessByCode($kioskCode, $pairingToken);

        if ($kiosk === null) {
            return null;
        }

        $match = $this->findPriorityMatchForKiosk((int) $kiosk['id']);

        if ($match === null) {
            return $this->buildKioskState($kiosk);
        }

        if ((string) $match['status'] === 'assigned') {
            $status = 'in_progress';
            $sql = sprintf(
                'UPDATE `%1$smatches`
                 SET status = ?, starts_at = COALESCE(starts_at, NOW())
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $matchId = (int) $match['id'];
            $statement->bind_param('si', $status, $matchId);
            $statement->execute();
            $statement->close();
        }

        $this->ensureCurrentLeg((int) $match['id']);

        return $this->buildKioskState($kiosk);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|null
     */
    public function recordVisitByCode(string $kioskCode, array $payload, ?string $pairingToken = null): ?array
    {
        $kiosk = $this->requireKioskAccessByCode($kioskCode, $pairingToken);

        if ($kiosk === null) {
            return null;
        }

        $match = $this->findPriorityMatchForKiosk((int) $kiosk['id']);

        if ($match === null) {
            return $this->buildKioskState($kiosk);
        }

        if ((string) $match['status'] === 'assigned') {
            $this->startAssignedMatchByCode($kioskCode);
            $match = $this->findPriorityMatchForKiosk((int) $kiosk['id']);
        }

        if ($match === null) {
            return $this->buildKioskState($kiosk);
        }

        $leg = $this->ensureCurrentLeg((int) $match['id']);
        $inputMode = (string) ($payload['input_mode'] ?? 'sum');
        $darts = is_array($payload['darts'] ?? null) ? $payload['darts'] : [];
        $score = $this->resolveVisitScore($inputMode, $payload, $darts);
        $dartsUsed = min(3, max(1, (int) ($payload['darts_used'] ?? 3)));

        if ($inputMode === 'sum' && !$this->isPossibleVisitScore($score)) {
            throw new KioskAccessException(
                'invalid_visit_score',
                'Denne summen kan ikke oppnas med tre piler.',
                422
            );
        }

        $remaining = $this->calculateRemainingScores((int) $match['id'], (int) $leg['id']);
        $currentPlayerId = $this->determineCurrentPlayerId($match, $leg);
        $remainingBefore = $remaining[$currentPlayerId] ?? 501;
        $remainingAfter = $remainingBefore - $score;
        $isBust = $this->isBustVisit($remainingBefore, $remainingAfter, $score, $inputMode, $darts);

        if ($isBust) {
            $remainingAfter = $remainingBefore;
        }

        $visitNumber = $this->nextVisitNumberForPlayer((int) $leg['id'], $currentPlayerId);
        $dartsJson = $darts !== [] ? json_encode($darts, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;

        $sql = sprintf(
            'INSERT INTO `%1$svisits`
             (match_id, leg_id, player_id, visit_number, score, darts_used, input_mode, darts_json, is_bust, remaining_after)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $matchId = (int) $match['id'];
        $legId = (int) $leg['id'];
        $bust = $isBust ? 1 : 0;
        $statement->bind_param(
            'iiiiiissii',
            $matchId,
            $legId,
            $currentPlayerId,
            $visitNumber,
            $score,
            $dartsUsed,
            $inputMode,
            $dartsJson,
            $bust,
            $remainingAfter
        );
        $statement->execute();
        $statement->close();

        if (!$isBust && $remainingAfter === 0) {
            $this->completeLeg($match, $leg, $currentPlayerId);
        }

        return $this->buildKioskState($kiosk);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function undoLastVisitByCode(string $kioskCode, ?string $pairingToken = null): ?array
    {
        $kiosk = $this->requireKioskAccessByCode($kioskCode, $pairingToken);

        if ($kiosk === null) {
            return null;
        }

        $match = $this->findPriorityMatchForKiosk((int) $kiosk['id'], true);

        if ($match === null) {
            return $this->buildKioskState($kiosk);
        }

        $this->removeTrailingEmptyLegs((int) $match['id']);
        $leg = $this->findLatestLeg((int) $match['id']);

        if ($leg === null) {
            return $this->buildKioskState($kiosk);
        }

        $visit = $this->findLatestVisit((int) $leg['id']);

        if ($visit === null) {
            return $this->buildKioskState($kiosk);
        }

        $this->reopenMatchAndLegIfNeeded($match, $leg);

        $sql = sprintf('DELETE FROM `%1$svisits` WHERE id = ?', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        $visitId = (int) $visit['id'];
        $statement->bind_param('i', $visitId);
        $statement->execute();
        $statement->close();

        return $this->buildKioskState($kiosk);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function pairKioskByCode(string $kioskCode, string $pairingToken, ?string $deviceName = null): ?array
    {
        $kiosk = $this->findKioskByCode($kioskCode);

        if ($kiosk === null) {
            return null;
        }

        $deviceName = $this->normalizeDeviceName($deviceName);
        $existingHash = (string) ($kiosk['pairing_token_hash'] ?? '');

        if ($existingHash !== '') {
            if (!password_verify($pairingToken, $existingHash)) {
                throw new KioskAccessException(
                    'kiosk_paired_to_other_device',
                    'Denne kiosken er allerede paret mot et annet nettbrett.',
                    409
                );
            }

            $this->touchKioskPairing((int) $kiosk['id'], $deviceName, false);
            $kiosk = $this->findKioskByCode($kioskCode);
            return $kiosk !== null ? $this->buildKioskState($kiosk) : null;
        }

        $tokenHash = password_hash($pairingToken, PASSWORD_DEFAULT);
        $sql = sprintf(
            'UPDATE `%1$skiosks`
             SET pairing_token_hash = ?, paired_device_name = ?, paired_at = NOW(), last_seen_at = NOW()
             WHERE id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $kioskId = (int) $kiosk['id'];
        $statement->bind_param('ssi', $tokenHash, $deviceName, $kioskId);
        $statement->execute();
        $statement->close();

        $kiosk = $this->findKioskByCode($kioskCode);
        return $kiosk !== null ? $this->buildKioskState($kiosk) : null;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function unpairKioskByCode(string $kioskCode, ?string $pairingToken = null): ?array
    {
        $kiosk = $this->requireKioskAccessByCode($kioskCode, $pairingToken);

        if ($kiosk === null) {
            return null;
        }

        $sql = sprintf(
            'UPDATE `%1$skiosks`
             SET pairing_token_hash = NULL, paired_device_name = NULL, paired_at = NULL
             WHERE id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $kioskId = (int) $kiosk['id'];
        $statement->bind_param('i', $kioskId);
        $statement->execute();
        $statement->close();

        $freshKiosk = $this->findKioskByCode($kioskCode);
        return $freshKiosk !== null ? $this->buildKioskState($freshKiosk) : null;
    }

    /**
     * @return array<string, mixed>
     */
    public function createPairingRequest(string $pairingToken, ?string $deviceName = null): array
    {
        $fingerprint = hash('sha256', $pairingToken);
        $existing = $this->findPendingPairingRequestByFingerprint($fingerprint);

        if ($existing !== null) {
            return $this->formatPairingRequest($existing);
        }

        $requestCode = $this->generatePairingRequestCode();
        $deviceName = $this->normalizeDeviceName($deviceName);
        $tokenHash = password_hash($pairingToken, PASSWORD_DEFAULT);
        $expiresAt = date('Y-m-d H:i:s', time() + 1800);

        $sql = sprintf(
            'INSERT INTO `%1$skiosk_pairing_requests`
             (request_code, pairing_token_hash, pairing_token_fingerprint, device_name, status, expires_at)
             VALUES (?, ?, ?, ?, "pending", ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('sssss', $requestCode, $tokenHash, $fingerprint, $deviceName, $expiresAt);
        $statement->execute();
        $statement->close();

        $request = $this->findPairingRequestByCode($requestCode);
        return $this->formatPairingRequest($request ?? []);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getPairingRequestStatus(string $requestCode, string $pairingToken): ?array
    {
        $request = $this->findPairingRequestByCode($requestCode);

        if ($request === null) {
            return null;
        }

        if (!hash_equals((string) $request['pairing_token_fingerprint'], hash('sha256', $pairingToken))) {
            throw new KioskAccessException(
                'kiosk_pairing_request_invalid',
                'Denne pairingforesporselen tilhorer et annet nettbrett.',
                403
            );
        }

        if ((string) $request['status'] === 'approved' && $request['approved_kiosk_id'] !== null) {
            $kiosk = $this->findKioskById((int) $request['approved_kiosk_id']);

            if ($kiosk !== null) {
                return [
                    'status' => 'approved',
                    'request' => $this->formatPairingRequest($request),
                    'kiosk' => $this->formatKiosk($kiosk),
                    'snapshot' => $this->buildKioskState($kiosk),
                ];
            }
        }

        return [
            'status' => (string) $request['status'],
            'request' => $this->formatPairingRequest($request),
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listPendingPairingRequests(): array
    {
        $sql = sprintf(
            'SELECT id, request_code, device_name, status, requested_at, expires_at
             FROM `%1$skiosk_pairing_requests`
             WHERE status = "pending" AND expires_at >= NOW()
             ORDER BY requested_at DESC',
            $this->tablePrefix
        );

        $result = $this->connection->query($sql);
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);

        return array_map(fn (array $row): array => $this->formatPairingRequest($row), $rows);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function approvePairingRequest(int $clubId, string $requestCode, int $kioskId, int $approvedByUserId): ?array
    {
        $request = $this->findPairingRequestByCode($requestCode);

        if ($request === null) {
            return null;
        }

        if ((string) $request['status'] !== 'pending') {
            return $this->formatPairingRequest($request);
        }

        $kiosk = $this->findKioskById($kioskId);

        if ($kiosk === null || (int) $kiosk['club_id'] !== $clubId) {
            return null;
        }

        $sql = sprintf(
            'UPDATE `%1$skiosks`
             SET pairing_token_hash = ?, paired_device_name = ?, paired_at = NOW(), last_seen_at = NOW()
             WHERE id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $tokenHash = (string) $request['pairing_token_hash'];
        $deviceName = (string) $request['device_name'];
        $statement->bind_param('ssi', $tokenHash, $deviceName, $kioskId);
        $statement->execute();
        $statement->close();

        $requestSql = sprintf(
            'UPDATE `%1$skiosk_pairing_requests`
             SET status = "approved", approved_kiosk_id = ?, approved_by_user_account_id = ?, approved_at = NOW(), consumed_at = NOW()
             WHERE id = ?',
            $this->tablePrefix
        );
        $requestStatement = $this->connection->prepare($requestSql);
        $requestId = (int) $request['id'];
        $requestStatement->bind_param('iii', $kioskId, $approvedByUserId, $requestId);
        $requestStatement->execute();
        $requestStatement->close();

        $freshRequest = $this->findPairingRequestByCode($requestCode);
        $freshKiosk = $this->findKioskById($kioskId);

        return [
            'request' => $this->formatPairingRequest($freshRequest ?? []),
            'kiosk' => $freshKiosk !== null ? $this->formatKiosk($freshKiosk) : null,
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listScreenBoardsByTournament(int $clubId, int $tournamentId): array
    {
        $kiosks = $this->listKiosksForClub($clubId);
        $boards = [];

        foreach ($kiosks as $kiosk) {
            $match = $this->findPriorityMatchForKiosk((int) $kiosk['id'], false, $tournamentId);

            if ($match === null) {
                $boards[] = [
                    'kiosk' => $this->formatKiosk($kiosk),
                    'state' => 'idle',
                    'match' => null,
                ];
                continue;
            }

            if ((string) $match['status'] === 'assigned') {
                $leg = $this->findOpenLeg((int) $match['id']) ?? $this->findLatestLeg((int) $match['id']) ?? [
                    'id' => null,
                    'leg_number' => 1,
                    'starting_player_id' => (int) $match['player_a_id'],
                    'status' => 'pending',
                ];
                $remaining = [
                    (int) $match['player_a_id'] => 501,
                    (int) $match['player_b_id'] => 501,
                ];
                $currentPlayerId = (int) $match['player_a_id'];
            } else {
                $leg = $this->ensureCurrentLeg((int) $match['id']);
                $remaining = $this->calculateRemainingScores((int) $match['id'], (int) $leg['id']);
                $currentPlayerId = (string) $match['status'] === 'completed' ? null : $this->determineCurrentPlayerId($match, $leg);
            }

            $legWins = $this->countLegWins((int) $match['id']);

            $boards[] = [
                'kiosk' => $this->formatKiosk($kiosk),
                'state' => $match['status'],
                'match' => [
                    'id' => (int) $match['id'],
                    'status' => $match['status'],
                    'round_label' => $match['round_label'],
                    'bracket_label' => $match['bracket_label'],
                    'best_of_legs' => (int) $match['best_of_legs'],
                    'legs_to_win' => (int) $match['legs_to_win'],
                    'player_a' => [
                        'id' => (int) $match['player_a_id'],
                        'display_name' => $match['player_a_name'],
                        'remaining' => $remaining[(int) $match['player_a_id']] ?? 501,
                        'legs_won' => $legWins[(int) $match['player_a_id']] ?? 0,
                    ],
                    'player_b' => [
                        'id' => (int) $match['player_b_id'],
                        'display_name' => $match['player_b_name'],
                        'remaining' => $remaining[(int) $match['player_b_id']] ?? 501,
                        'legs_won' => $legWins[(int) $match['player_b_id']] ?? 0,
                    ],
                    'current_player_id' => $currentPlayerId,
                    'recent_visits' => $this->listRecentVisits((int) $match['id'], 2),
                ],
            ];
        }

        return $boards;
    }

    /**
     * @param array<string, mixed> $kiosk
     * @return array<string, mixed>
     */
    private function buildKioskState(array $kiosk): array
    {
        $match = $this->findPriorityMatchForKiosk((int) $kiosk['id']);

        if ($match === null) {
            return [
                'kiosk' => $this->formatKiosk($kiosk),
                'state' => 'idle',
                'message' => 'No assigned or active match for this kiosk.',
            ];
        }

        if ((string) $match['status'] === 'assigned') {
            $leg = $this->findOpenLeg((int) $match['id']) ?? $this->findLatestLeg((int) $match['id']) ?? [
                'id' => null,
                'leg_number' => 1,
                'starting_player_id' => (int) $match['player_a_id'],
                'status' => 'pending',
            ];
            $remaining = [
                (int) $match['player_a_id'] => 501,
                (int) $match['player_b_id'] => 501,
            ];
            $currentPlayerId = (int) $match['player_a_id'];
        } else {
            $leg = $this->ensureCurrentLeg((int) $match['id']);
            $remaining = $this->calculateRemainingScores((int) $match['id'], (int) $leg['id']);
            $currentPlayerId = (string) $match['status'] === 'completed' ? null : $this->determineCurrentPlayerId($match, $leg);
        }

        $legWins = $this->countLegWins((int) $match['id']);

        return [
            'kiosk' => $this->formatKiosk($kiosk),
            'state' => $match['status'],
            'match' => [
                'id' => (int) $match['id'],
                'status' => $match['status'],
                'round_label' => $match['round_label'],
                'bracket_label' => $match['bracket_label'],
                'best_of_legs' => (int) $match['best_of_legs'],
                'legs_to_win' => (int) $match['legs_to_win'],
                'player_a' => [
                    'id' => (int) $match['player_a_id'],
                    'display_name' => $match['player_a_name'],
                    'remaining' => $remaining[(int) $match['player_a_id']] ?? 501,
                    'legs_won' => $legWins[(int) $match['player_a_id']] ?? 0,
                ],
                'player_b' => [
                    'id' => (int) $match['player_b_id'],
                    'display_name' => $match['player_b_name'],
                    'remaining' => $remaining[(int) $match['player_b_id']] ?? 501,
                    'legs_won' => $legWins[(int) $match['player_b_id']] ?? 0,
                ],
                'winner_player_id' => $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : null,
                'starts_at' => $match['starts_at'],
                'finished_at' => $match['finished_at'],
                'current_leg' => [
                    'id' => isset($leg['id']) && $leg['id'] !== null ? (int) $leg['id'] : null,
                    'leg_number' => (int) $leg['leg_number'],
                    'starting_player_id' => isset($leg['starting_player_id']) ? (int) $leg['starting_player_id'] : null,
                    'status' => $leg['status'],
                ],
                'current_player_id' => $currentPlayerId,
                'recent_visits' => $this->listRecentVisits((int) $match['id'], 8),
            ],
        ];
    }

    /**
     * @param array<string, mixed> $kiosk
     * @return array<string, mixed>
     */
    private function formatKiosk(array $kiosk): array
    {
        return [
            'id' => (int) $kiosk['id'],
            'code' => $kiosk['code'],
            'name' => $kiosk['name'],
            'club' => [
                'id' => isset($kiosk['club_id']) ? (int) $kiosk['club_id'] : null,
                'name' => $kiosk['club_name'] ?? null,
                'logo_url' => $kiosk['club_logo_url'] ?? null,
            ],
            'board_number' => (int) $kiosk['board_number'],
            'sponsor_label' => $kiosk['sponsor_label'],
            'sponsor_logo_url' => $kiosk['sponsor_logo_url'],
            'scoring_mode' => $kiosk['scoring_mode'] ?? 'manual',
            'is_paired' => !empty($kiosk['pairing_token_hash']),
            'paired_device_name' => $kiosk['paired_device_name'] ?? null,
            'paired_at' => $kiosk['paired_at'] ?? null,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function formatPairingRequest(array $request): array
    {
        return [
            'id' => isset($request['id']) ? (int) $request['id'] : null,
            'request_code' => $request['request_code'] ?? null,
            'device_name' => $request['device_name'] ?? null,
            'status' => $request['status'] ?? 'pending',
            'requested_at' => $request['requested_at'] ?? null,
            'expires_at' => $request['expires_at'] ?? null,
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listKiosksForClub(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                k.id,
                k.club_id,
                c.name AS club_name,
                c.logo_url AS club_logo_url,
                k.code,
                k.name,
                k.board_number,
                k.sponsor_label,
                k.sponsor_logo_url,
                k.scoring_mode,
                k.pairing_token_hash,
                k.paired_device_name,
                k.paired_at
             FROM `%1$skiosks` k
             INNER JOIN `%1$sclubs` c ON c.id = k.club_id
             WHERE k.club_id = ? AND k.is_active = 1
             ORDER BY k.board_number ASC, k.name ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findKioskByCode(string $kioskCode): ?array
    {
        $sql = sprintf(
            'SELECT
                k.id,
                k.club_id,
                c.name AS club_name,
                c.logo_url AS club_logo_url,
                k.code,
                k.name,
                k.board_number,
                k.sponsor_label,
                k.sponsor_logo_url,
                k.scoring_mode,
                k.pairing_token_hash,
                k.paired_device_name,
                k.paired_at
             FROM `%1$skiosks` k
             INNER JOIN `%1$sclubs` c ON c.id = k.club_id
             WHERE code = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $kioskCode);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findKioskById(int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT
                k.id,
                k.club_id,
                c.name AS club_name,
                c.logo_url AS club_logo_url,
                k.code,
                k.name,
                k.board_number,
                k.sponsor_label,
                k.sponsor_logo_url,
                k.scoring_mode,
                k.pairing_token_hash,
                k.paired_device_name,
                k.paired_at
             FROM `%1$skiosks` k
             INNER JOIN `%1$sclubs` c ON c.id = k.club_id
             WHERE k.id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $kioskId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findPendingPairingRequestByFingerprint(string $fingerprint): ?array
    {
        $sql = sprintf(
            'SELECT id, request_code, pairing_token_hash, pairing_token_fingerprint, device_name, status, requested_at, expires_at, approved_kiosk_id
             FROM `%1$skiosk_pairing_requests`
             WHERE pairing_token_fingerprint = ? AND status = "pending" AND expires_at >= NOW()
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $fingerprint);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findPairingRequestByCode(string $requestCode): ?array
    {
        $sql = sprintf(
            'SELECT id, request_code, pairing_token_hash, pairing_token_fingerprint, device_name, status, requested_at, expires_at, approved_kiosk_id
             FROM `%1$skiosk_pairing_requests`
             WHERE request_code = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $requestCode);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    private function generatePairingRequestCode(): string
    {
        do {
            $code = 'PAIR-' . strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));
        } while ($this->findPairingRequestByCode($code) !== null);

        return $code;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function requireKioskAccessByCode(string $kioskCode, ?string $pairingToken): ?array
    {
        $kiosk = $this->findKioskByCode($kioskCode);

        if ($kiosk === null) {
            return null;
        }

        $existingHash = (string) ($kiosk['pairing_token_hash'] ?? '');

        if ($existingHash === '') {
            return $kiosk;
        }

        if (!is_string($pairingToken) || trim($pairingToken) === '') {
            throw new KioskAccessException(
                'kiosk_pairing_required',
                'Denne kiosken er paret til et nettbrett og krever gyldig paringstoken.',
                403
            );
        }

        if (!password_verify($pairingToken, $existingHash)) {
            throw new KioskAccessException(
                'kiosk_paired_to_other_device',
                'Denne kiosken er allerede paret mot et annet nettbrett.',
                409
            );
        }

        $this->touchKioskPairing((int) $kiosk['id'], null, true);

        return $this->findKioskByCode($kioskCode);
    }

    private function touchKioskPairing(int $kioskId, ?string $deviceName = null, bool $keepPairingDate = true): void
    {
        if ($deviceName !== null) {
            $sql = sprintf(
                'UPDATE `%1$skiosks`
                 SET last_seen_at = NOW(), paired_device_name = ?, paired_at = %2$s
                 WHERE id = ?',
                $this->tablePrefix,
                $keepPairingDate ? 'paired_at' : 'NOW()'
            );
            $statement = $this->connection->prepare($sql);
            $statement->bind_param('si', $deviceName, $kioskId);
            $statement->execute();
            $statement->close();
            return;
        }

        $sql = sprintf(
            'UPDATE `%1$skiosks` SET last_seen_at = NOW() WHERE id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $kioskId);
        $statement->execute();
        $statement->close();
    }

    private function normalizeDeviceName(?string $deviceName): string
    {
        $deviceName = trim((string) $deviceName);

        if ($deviceName === '') {
            return 'Nettbrett';
        }

        return substr($deviceName, 0, 150);
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findPriorityMatchForKiosk(int $kioskId, bool $includeCompleted = false, ?int $tournamentId = null): ?array
    {
        $statuses = $includeCompleted
            ? '("in_progress", "assigned", "completed")'
            : '("in_progress", "assigned")';

        $tournamentFilter = $tournamentId !== null ? ' AND m.tournament_id = ?' : '';

        $sql = sprintf(
            'SELECT
                m.id,
                m.status,
                m.round_label,
                m.bracket_label,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                m.player_b_id,
                m.winner_player_id,
                m.starts_at,
                m.finished_at,
                pa.display_name AS player_a_name,
                pb.display_name AS player_b_name
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             WHERE m.kiosk_id = ?
               AND m.status IN ' . $statuses . $tournamentFilter . '
             ORDER BY FIELD(m.status, "in_progress", "assigned", "completed"), m.id ASC
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);

        if ($tournamentId !== null) {
            $statement->bind_param('ii', $kioskId, $tournamentId);
        } else {
            $statement->bind_param('i', $kioskId);
        }

        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>
     */
    private function ensureCurrentLeg(int $matchId): array
    {
        $leg = $this->findOpenLeg($matchId);

        if ($leg !== null) {
            if ((string) $leg['status'] === 'pending') {
                $status = 'in_progress';
                $sql = sprintf('UPDATE `%1$slegs` SET status = ? WHERE id = ?', $this->tablePrefix);
                $statement = $this->connection->prepare($sql);
                $legId = (int) $leg['id'];
                $statement->bind_param('si', $status, $legId);
                $statement->execute();
                $statement->close();
                $leg['status'] = 'in_progress';
            }

            return $leg;
        }

        $match = $this->findMatchBasics($matchId);
        $latestLeg = $this->findLatestLeg($matchId);
        $legNumber = $latestLeg !== null ? ((int) $latestLeg['leg_number']) + 1 : 1;

        $startingPlayerId = $match['player_a_id'];

        if ($latestLeg !== null) {
            $startingPlayerId = (int) $latestLeg['starting_player_id'] === (int) $match['player_a_id']
                ? (int) $match['player_b_id']
                : (int) $match['player_a_id'];
        }

        $status = 'in_progress';
        $startScore = 501;
        $sql = sprintf(
            'INSERT INTO `%1$slegs` (match_id, leg_number, starting_player_id, status, start_score)
             VALUES (?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iiisi', $matchId, $legNumber, $startingPlayerId, $status, $startScore);
        $statement->execute();
        $legId = (int) $statement->insert_id;
        $statement->close();

        return [
            'id' => $legId,
            'match_id' => $matchId,
            'leg_number' => $legNumber,
            'starting_player_id' => $startingPlayerId,
            'status' => $status,
            'start_score' => $startScore,
        ];
    }

    /**
     * @return array<int, int>
     */
    private function calculateRemainingScores(int $matchId, int $legId): array
    {
        $match = $this->findMatchBasics($matchId);
        $remaining = [
            (int) $match['player_a_id'] => 501,
            (int) $match['player_b_id'] => 501,
        ];

        $sql = sprintf(
            'SELECT player_id, score, is_bust
             FROM `%1$svisits`
             WHERE leg_id = ?
             ORDER BY id ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $legId);
        $statement->execute();
        $result = $statement->get_result();

        while ($row = $result->fetch_assoc()) {
            $playerId = (int) $row['player_id'];
            if ((int) $row['is_bust'] === 1) {
                continue;
            }

            $remaining[$playerId] = ($remaining[$playerId] ?? 501) - (int) $row['score'];
        }

        $statement->close();

        return $remaining;
    }

    /**
     * @param array<string, mixed> $match
     * @param array<string, mixed> $leg
     */
    private function determineCurrentPlayerId(array $match, array $leg): int
    {
        $sql = sprintf(
            'SELECT COUNT(*) AS total_visits
             FROM `%1$svisits`
             WHERE leg_id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $legId = (int) $leg['id'];
        $statement->bind_param('i', $legId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: ['total_visits' => 0];
        $statement->close();

        $startingPlayerId = (int) $leg['starting_player_id'];
        $otherPlayerId = $startingPlayerId === (int) $match['player_a_id']
            ? (int) $match['player_b_id']
            : (int) $match['player_a_id'];

        return ((int) $row['total_visits'] % 2 === 0) ? $startingPlayerId : $otherPlayerId;
    }

    private function nextVisitNumberForPlayer(int $legId, int $playerId): int
    {
        $sql = sprintf(
            'SELECT COALESCE(MAX(visit_number), 0) AS max_visit_number
             FROM `%1$svisits`
             WHERE leg_id = ? AND player_id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $legId, $playerId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: ['max_visit_number' => 0];
        $statement->close();

        return ((int) $row['max_visit_number']) + 1;
    }

    /**
     * @param array<string, mixed> $match
     * @param array<string, mixed> $leg
     */
    private function completeLeg(array $match, array $leg, int $winnerPlayerId): void
    {
        $legStatus = 'completed';
        $sql = sprintf(
            'UPDATE `%1$slegs`
             SET winner_player_id = ?, status = ?, finished_at = NOW()
             WHERE id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $legId = (int) $leg['id'];
        $statement->bind_param('isi', $winnerPlayerId, $legStatus, $legId);
        $statement->execute();
        $statement->close();

        $wins = $this->countLegWins((int) $match['id']);
        $playerWins = $wins[$winnerPlayerId] ?? 0;

        if ($playerWins >= (int) $match['legs_to_win']) {
            $matchStatus = 'completed';
            $update = sprintf(
                'UPDATE `%1$smatches`
                 SET status = ?, winner_player_id = ?, finished_at = NOW()
                 WHERE id = ?',
                $this->tablePrefix
            );
            $complete = $this->connection->prepare($update);
            $matchId = (int) $match['id'];
            $complete->bind_param('sii', $matchStatus, $winnerPlayerId, $matchId);
            $complete->execute();
            $complete->close();
            return;
        }

        $this->ensureCurrentLeg((int) $match['id']);
    }

    /**
     * @return array<int, int>
     */
    private function countLegWins(int $matchId): array
    {
        $sql = sprintf(
            'SELECT winner_player_id, COUNT(*) AS win_count
             FROM `%1$slegs`
             WHERE match_id = ? AND winner_player_id IS NOT NULL
             GROUP BY winner_player_id',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $result = $statement->get_result();

        $wins = [];

        while ($row = $result->fetch_assoc()) {
            $wins[(int) $row['winner_player_id']] = (int) $row['win_count'];
        }

        $statement->close();

        return $wins;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listRecentVisits(int $matchId, int $limit): array
    {
        $sql = sprintf(
            'SELECT
                v.id,
                v.leg_id,
                v.player_id,
                p.display_name AS player_name,
                v.visit_number,
                v.score,
                v.darts_used,
                v.input_mode,
                v.is_bust,
                v.remaining_after,
                v.created_at
             FROM `%1$svisits` v
             INNER JOIN `%1$splayers` p ON p.id = v.player_id
             WHERE v.match_id = ?
             ORDER BY v.id DESC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    private function removeTrailingEmptyLegs(int $matchId): void
    {
        while (true) {
            $latestLeg = $this->findLatestLeg($matchId);

            if ($latestLeg === null) {
                return;
            }

            $sql = sprintf(
                'SELECT COUNT(*) AS visit_count FROM `%1$svisits` WHERE leg_id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $legId = (int) $latestLeg['id'];
            $statement->bind_param('i', $legId);
            $statement->execute();
            $result = $statement->get_result();
            $row = $result->fetch_assoc() ?: ['visit_count' => 0];
            $statement->close();

            if ((int) $row['visit_count'] > 0) {
                return;
            }

            $deleteSql = sprintf('DELETE FROM `%1$slegs` WHERE id = ?', $this->tablePrefix);
            $delete = $this->connection->prepare($deleteSql);
            $delete->bind_param('i', $legId);
            $delete->execute();
            $delete->close();
        }
    }

    /**
     * @param array<string, mixed> $match
     * @param array<string, mixed> $leg
     */
    private function reopenMatchAndLegIfNeeded(array $match, array $leg): void
    {
        if ((string) $leg['status'] === 'completed') {
            $legStatus = 'in_progress';
            $sql = sprintf(
                'UPDATE `%1$slegs`
                 SET winner_player_id = NULL, status = ?, finished_at = NULL
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $legId = (int) $leg['id'];
            $statement->bind_param('si', $legStatus, $legId);
            $statement->execute();
            $statement->close();
        }

        if ((string) $match['status'] === 'completed') {
            $matchStatus = 'in_progress';
            $sql = sprintf(
                'UPDATE `%1$smatches`
                 SET status = ?, winner_player_id = NULL, finished_at = NULL
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $matchId = (int) $match['id'];
            $statement->bind_param('si', $matchStatus, $matchId);
            $statement->execute();
            $statement->close();
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findMatchBasics(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT id, player_a_id, player_b_id, legs_to_win
             FROM `%1$smatches`
             WHERE id = ?
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findOpenLeg(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT id, match_id, leg_number, starting_player_id, status, start_score
             FROM `%1$slegs`
             WHERE match_id = ? AND status IN ("pending", "in_progress")
             ORDER BY leg_number DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findLatestLeg(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT id, match_id, leg_number, starting_player_id, status, start_score
             FROM `%1$slegs`
             WHERE match_id = ?
             ORDER BY leg_number DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findLatestVisit(int $legId): ?array
    {
        $sql = sprintf(
            'SELECT id, leg_id, player_id, score, is_bust, remaining_after
             FROM `%1$svisits`
             WHERE leg_id = ?
             ORDER BY id DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $legId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @param array<int, array<string, mixed>> $darts
     */
    private function resolveVisitScore(string $inputMode, array $payload, array $darts): int
    {
        if ($inputMode === 'per_dart') {
            return $this->calculateDartsScore($darts);
        }

        return max(0, (int) ($payload['score'] ?? 0));
    }

    /**
     * @param array<int, array<string, mixed>> $darts
     */
    private function calculateDartsScore(array $darts): int
    {
        $score = 0;

        foreach ($darts as $dart) {
            $multiplier = strtoupper(trim((string) ($dart['multiplier'] ?? $dart['m'] ?? 'S')));
            $value = $dart['value'] ?? $dart['v'] ?? 0;

            if (is_string($value) && strtoupper($value) === 'BULL') {
                $score += $multiplier === 'D' ? 50 : 25;
                continue;
            }

            $numericValue = max(0, (int) $value);

            if ($numericValue === 0) {
                continue;
            }

            $score += match ($multiplier) {
                'D' => $numericValue * 2,
                'T' => $numericValue * 3,
                default => $numericValue,
            };
        }

        return $score;
    }

    /**
     * @param array<int, array<string, mixed>> $darts
     */
    private function isBustVisit(int $remainingBefore, int $remainingAfter, int $score, string $inputMode, array $darts): bool
    {
        if ($score > 180 || $remainingAfter < 0 || $remainingAfter === 1) {
            return true;
        }

        if ($remainingAfter !== 0) {
            return false;
        }

        if ($inputMode === 'per_dart') {
            return !$this->isDoubleOutDartSequence($darts);
        }

        return !$this->isCheckoutNumber($remainingBefore);
    }

    private function isCheckoutNumber(int $remainingBefore): bool
    {
        if ($remainingBefore <= 1 || $remainingBefore > 170) {
            return false;
        }

        return !in_array($remainingBefore, [159, 161, 162, 163, 165, 166, 168, 169], true);
    }

    private function isPossibleVisitScore(int $score): bool
    {
        static $possibleScores = null;

        if (!is_array($possibleScores)) {
            $singleDartScores = [0, 25, 50];

            for ($value = 1; $value <= 20; $value++) {
                $singleDartScores[] = $value;
                $singleDartScores[] = $value * 2;
                $singleDartScores[] = $value * 3;
            }

            $singleDartScores = array_values(array_unique($singleDartScores));
            $possibleScores = [];

            foreach ($singleDartScores as $first) {
                foreach ($singleDartScores as $second) {
                    foreach ($singleDartScores as $third) {
                        $possibleScores[$first + $second + $third] = true;
                    }
                }
            }
        }

        return isset($possibleScores[$score]);
    }

    /**
     * @param array<int, array<string, mixed>> $darts
     */
    private function isDoubleOutDartSequence(array $darts): bool
    {
        for ($index = count($darts) - 1; $index >= 0; $index--) {
            $dart = $darts[$index];
            $multiplier = strtoupper(trim((string) ($dart['multiplier'] ?? $dart['m'] ?? 'S')));
            $value = $dart['value'] ?? $dart['v'] ?? 0;

            if (is_string($value) && strtoupper($value) === 'BULL') {
                return $multiplier === 'D';
            }

            $numericValue = (int) $value;

            if ($numericValue <= 0) {
                continue;
            }

            return $multiplier === 'D';
        }

        return false;
    }
}
