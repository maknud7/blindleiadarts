<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Throwable;

final class ScoliaScoringService
{
    public function __construct(
        private readonly ScoliaRepository $scolia,
        private readonly CanonicalScoringService $scoring,
        private readonly Dart501Rules $rules = new Dart501Rules(),
        private readonly ScoliaSectorMapper $mapper = new ScoliaSectorMapper()
    ) {
    }

    /** @return array{claimed:int,processed:int,failed:int} */
    public function drain(int $limit = 25): array
    {
        $events = $this->scolia->claimQueuedEvents($limit);
        $processed = 0;
        $failed = 0;
        foreach ($events as $event) {
            try {
                $result = $this->processEvent($event);
                $this->scolia->markEventProcessed(
                    (int) $event['id'],
                    (string) ($result['status'] ?? 'processed'),
                    isset($result['visit_id']) ? (int) $result['visit_id'] : null,
                    $result['meta'] ?? null
                );
                $processed++;
            } catch (Throwable $error) {
                $this->scolia->markEventFailed($event, $error);
                $failed++;
            }
        }
        return ['claimed' => count($events), 'processed' => $processed, 'failed' => $failed];
    }

    /** @param array<string,mixed> $event @return array{status:string,visit_id?:int,meta?:array<string,mixed>} */
    public function processEvent(array $event): array
    {
        $kioskId = (int) $event['kiosk_id'];
        $clubId = (int) $event['club_id'];
        $type = strtoupper((string) ($event['event_type'] ?? 'UNKNOWN'));
        $message = is_array($event['payload'] ?? null) ? $event['payload'] : [];
        $payload = is_array($message['payload'] ?? null) ? $message['payload'] : [];
        $board = $this->scolia->getBoardSettings($clubId, $kioskId);
        if ($board === null) {
            throw new ValidationException('scolia_board_not_found', 'Scolia-boardet finnes ikke lenger.', 404);
        }
        $mode = (string) ($board['mode'] ?? 'off');

        if ($type === 'BRIDGE_CONNECTED') {
            $this->scolia->bridgeHeartbeat($kioskId, 'connected');
            return ['status' => 'processed', 'meta' => ['connection' => 'connected']];
        }
        if ($type === 'BRIDGE_DISCONNECTED') {
            $reason = trim((string) ($payload['reason'] ?? $message['reason'] ?? 'Scolia WebSocket disconnected'));
            $this->scolia->markDisconnected($kioskId, $reason);
            return ['status' => 'processed', 'meta' => ['connection' => 'disconnected']];
        }
        if ($type === 'BRIDGE_ERROR') {
            $reason = trim((string) ($payload['error'] ?? $message['error'] ?? 'Ukjent bridge-feil'));
            $this->scolia->markDisconnected($kioskId, $reason);
            $this->scolia->recordIncident($clubId, $kioskId, $event['match_id'] ? (int) $event['match_id'] : null, 'error', 'bridge_error', 'Scolia Bridge rapporterte en feil', $reason);
            return ['status' => 'processed', 'meta' => ['bridge_error' => $reason]];
        }

        if ($mode === 'off') {
            return ['status' => 'ignored', 'meta' => ['reason' => 'scolia_disabled_for_board']];
        }

        if ($type === 'HELLO_CLIENT') {
            $this->scolia->updateRuntimeFromHello($kioskId, $payload);
            return ['status' => 'processed', 'meta' => ['hello' => true]];
        }
        if (in_array($type, ['SBC_STATUS_CHANGED','SBC_BOARD_AVAILABILITY_CHANGED'], true)) {
            $this->scolia->updateRuntimeStatus($kioskId, $payload);
            return ['status' => 'processed', 'meta' => ['status_update' => true]];
        }
        if ($type === 'TAKEOUT_STARTED') {
            $this->scolia->updateRuntimeStatus($kioskId, array_merge($payload, ['boardPhase' => 'Takeout']));
            return ['status' => 'processed', 'meta' => ['takeout_started' => true]];
        }
        if ($type === 'TAKEOUT_FINISHED') {
            $falseTakeout = $this->boolValue($payload['falseTakeout'] ?? $payload['false_takeout'] ?? false);
            $this->scolia->updateRuntimeStatus($kioskId, array_merge($payload, ['boardPhase' => $falseTakeout ? 'Takeout' : 'Throw']));
            if ($falseTakeout) {
                return ['status' => 'processed', 'meta' => ['false_takeout' => true]];
            }
            $buffer = $this->scolia->getVisitBuffer($kioskId);
            $result = null;
            if ($buffer !== null && count($buffer['darts'] ?? []) > 0) {
                $result = $this->finalizeBuffer($clubId, $kioskId, $mode, $buffer);
            }
            $this->scolia->setTurnLocked($kioskId, false);
            return $result ?? ['status' => 'processed', 'meta' => ['takeout_finished' => true]];
        }
        if ($type !== 'THROW_DETECTED') {
            return ['status' => 'ignored', 'meta' => ['reason' => 'unsupported_event_type']];
        }

        if ((int) ($board['fallback_active'] ?? 0) === 1 || (int) ($board['needs_reconciliation'] ?? 0) === 1) {
            return ['status' => 'ignored', 'meta' => ['reason' => 'manual_fallback_or_reconciliation']];
        }
        if ($this->scolia->isTurnLocked($kioskId)) {
            return ['status' => 'ignored', 'meta' => ['reason' => 'turn_complete_waiting_for_takeout']];
        }

        $this->scoring->startMatch($kioskId, 'scolia');
        $context = $this->scolia->getScoringContext($kioskId);
        if ($context === null) {
            return ['status' => 'ignored', 'meta' => ['reason' => 'no_active_match']];
        }

        $buffer = $this->scolia->getVisitBuffer($kioskId);
        if ($buffer !== null && ((int) $buffer['match_id'] !== (int) $context['match_id'] || (int) $buffer['player_id'] !== (int) $context['player_id'])) {
            $this->scolia->markDisconnected($kioskId, 'Scolia-bufferen samsvarer ikke med aktiv kamp/spiller. Manuell avstemming kreves.');
            throw new ValidationException('scolia_buffer_context_mismatch', 'Scolia-bufferen samsvarer ikke med canonical kampstate.', 409);
        }

        $sector = (string) ($payload['sector'] ?? 'None');
        $bounceout = $this->boolValue($payload['bounceout'] ?? false);
        $mapped = $this->mapper->toCanonical($sector, $bounceout);
        $dart = ['multiplier' => $mapped['multiplier'], 'value' => $mapped['value']];
        $darts = $buffer['darts'] ?? [];
        $eventIds = $buffer['event_ids'] ?? [];
        $providerIds = $buffer['provider_event_ids'] ?? [];
        if (count($darts) >= 3) {
            $this->scolia->markDisconnected($kioskId, 'Mer enn tre Scolia-kast ble registrert før takeout. Manuell avstemming kreves.');
            throw new ValidationException('scolia_too_many_darts', 'Mer enn tre piler i samme Scolia-visit.', 409);
        }
        $darts[] = $dart;
        $eventIds[] = (int) $event['id'];
        $providerId = trim((string) ($event['provider_event_id'] ?? ''));
        if ($providerId !== '') $providerIds[] = $providerId;

        $this->scolia->saveVisitBuffer($kioskId, (int) $context['match_id'], (int) $context['player_id'], $darts, $eventIds, $providerIds);
        $evaluation = $this->rules->evaluateVisit((int) $context['remaining'], [
            'input_mode' => 'per_dart',
            'darts' => $darts,
            'darts_used' => count($darts),
        ]);

        if (count($darts) === 3 || $evaluation['is_bust'] || $evaluation['is_checkout']) {
            $fresh = $this->scolia->getVisitBuffer($kioskId);
            if ($fresh === null) throw new ValidationException('scolia_buffer_missing', 'Scolia-bufferen forsvant under behandling.', 409);
            $result = $this->finalizeBuffer($clubId, $kioskId, $mode, $fresh);
            $this->scolia->setTurnLocked($kioskId, true);
            return $result;
        }

        return [
            'status' => 'processed',
            'meta' => [
                'buffered' => true,
                'dart_index' => count($darts) - 1,
                'dart' => $mapped,
                'remaining_if_visit_ended_now' => $evaluation['remaining_after'],
            ],
        ];
    }

    /** @param array<string,mixed> $buffer @return array{status:string,visit_id?:int,meta:array<string,mixed>} */
    private function finalizeBuffer(int $clubId, int $kioskId, string $mode, array $buffer): array
    {
        $context = $this->scolia->getScoringContext($kioskId);
        if ($context === null) {
            throw new ValidationException('scolia_no_scoring_context', 'Ingen aktiv canonical kamp finnes for Scolia-visiten.', 409);
        }
        if ((int) $buffer['match_id'] !== (int) $context['match_id'] || (int) $buffer['player_id'] !== (int) $context['player_id']) {
            $this->scolia->markDisconnected($kioskId, 'Scolia-visiten kunne ikke avstemmes mot canonical spiller.');
            throw new ValidationException('scolia_visit_context_changed', 'Canonical turrekkefølge endret seg før Scolia-visiten ble ferdig.', 409);
        }
        $darts = array_values($buffer['darts'] ?? []);
        if ($darts === []) {
            $this->scolia->clearVisitBuffer($kioskId);
            return ['status' => 'processed', 'meta' => ['empty_buffer' => true]];
        }
        $evaluation = $this->rules->evaluateVisit((int) $context['remaining'], [
            'input_mode' => 'per_dart',
            'darts' => $darts,
            'darts_used' => count($darts),
        ]);
        $eventIds = array_map('intval', $buffer['event_ids'] ?? []);
        $requestKey = 'scolia-' . hash('sha256', implode(',', $eventIds));

        if ($mode === 'shadow') {
            $shadowId = $this->scolia->storeShadowVisit(
                $kioskId,
                (int) $context['match_id'],
                (int) $context['player_id'],
                $darts,
                $eventIds,
                $evaluation,
                (int) $context['remaining']
            );
            $this->scolia->clearVisitBuffer($kioskId);
            return [
                'status' => 'processed',
                'meta' => [
                    'shadow_visit_id' => $shadowId,
                    'score' => $evaluation['score'],
                    'darts_used' => $evaluation['darts_used'],
                    'is_bust' => $evaluation['is_bust'],
                    'is_checkout' => $evaluation['is_checkout'],
                ],
            ];
        }

        if ($mode !== 'live') {
            $this->scolia->clearVisitBuffer($kioskId);
            return ['status' => 'ignored', 'meta' => ['reason' => 'board_not_live']];
        }

        $this->scoring->recordVisit($kioskId, [
            'input_mode' => 'per_dart',
            'darts' => $darts,
            'darts_used' => count($darts),
            'request_id' => $requestKey,
        ], 'scolia');
        $visitId = $this->scolia->findVisitByRequestKey($requestKey);
        $this->scolia->clearVisitBuffer($kioskId);
        return [
            'status' => 'processed',
            'visit_id' => $visitId ?? 0,
            'meta' => [
                'canonical' => true,
                'source' => 'scolia',
                'request_id' => $requestKey,
                'score' => $evaluation['score'],
                'darts_used' => $evaluation['darts_used'],
                'is_bust' => $evaluation['is_bust'],
                'is_checkout' => $evaluation['is_checkout'],
            ],
        ];
    }

    /** @return array<string,mixed> */
    public function deleteBufferedThrow(int $clubId, int $kioskId, ?int $index, int $userId): array
    {
        $buffer = $this->scolia->getVisitBuffer($kioskId);
        if ($buffer === null || ($buffer['darts'] ?? []) === []) {
            throw new ValidationException('scolia_no_buffered_throw', 'Det finnes ingen uferdig Scolia-pil å slette.', 409);
        }
        $darts = array_values($buffer['darts']);
        $eventIds = array_values($buffer['event_ids']);
        $providerIds = array_values($buffer['provider_event_ids']);
        $throwIndex = $index ?? (count($darts) - 1);
        if ($throwIndex < 0 || $throwIndex >= count($darts)) {
            throw new ValidationException('invalid_throw_index', 'Ugyldig Scolia throwIndex.');
        }
        array_splice($darts, $throwIndex, 1);
        array_splice($eventIds, $throwIndex, 1);
        if (isset($providerIds[$throwIndex])) array_splice($providerIds, $throwIndex, 1);
        if ($darts === []) {
            $this->scolia->clearVisitBuffer($kioskId);
        } else {
            $this->scolia->saveVisitBuffer($kioskId, (int) $buffer['match_id'], (int) $buffer['player_id'], $darts, $eventIds, $providerIds);
        }
        $command = $this->scolia->queueCommand($clubId, $kioskId, 'DELETE_THROW', ['throwIndex' => $throwIndex], $userId);
        return ['buffer' => $this->scolia->getVisitBuffer($kioskId), 'command' => $command];
    }

    /** @return array<string,mixed> */
    public function correctBufferedThrow(int $clubId, int $kioskId, int $index, string $sector, int $userId): array
    {
        $buffer = $this->scolia->getVisitBuffer($kioskId);
        if ($buffer === null || ($buffer['darts'] ?? []) === []) {
            throw new ValidationException('scolia_no_buffered_throw', 'Det finnes ingen uferdig Scolia-pil å korrigere.', 409);
        }
        $darts = array_values($buffer['darts']);
        if ($index < 0 || $index >= count($darts)) {
            throw new ValidationException('invalid_throw_index', 'Ugyldig Scolia throwIndex.');
        }
        $mapped = $this->mapper->toCanonical($sector, false);
        $darts[$index] = ['multiplier' => $mapped['multiplier'], 'value' => $mapped['value']];
        $this->scolia->saveVisitBuffer(
            $kioskId,
            (int) $buffer['match_id'],
            (int) $buffer['player_id'],
            $darts,
            array_values($buffer['event_ids']),
            array_values($buffer['provider_event_ids'])
        );
        $command = $this->scolia->queueCommand($clubId, $kioskId, 'THROW_CORRECTED', ['throwIndex' => $index], $userId);
        return ['buffer' => $this->scolia->getVisitBuffer($kioskId), 'command' => $command, 'corrected_to' => $mapped];
    }

    /** @return array<string,mixed> */
    public function resetPhase(int $clubId, int $kioskId, int $userId): array
    {
        $this->scolia->clearVisitBuffer($kioskId);
        $this->scolia->setTurnLocked($kioskId, false);
        return $this->scolia->queueCommand($clubId, $kioskId, 'RESET_PHASE', [], $userId);
    }

    /** @return array<string,mixed> */
    public function resumeAfterReconciliation(int $clubId, int $kioskId, int $userId): array
    {
        $this->scolia->resumeScolia($clubId, $kioskId, $userId);
        return $this->scolia->queueCommand($clubId, $kioskId, 'RESET_PHASE', [], $userId);
    }

    private function boolValue(mixed $value): bool
    {
        if (is_bool($value)) return $value;
        return in_array(strtolower(trim((string) $value)), ['1','true','yes','on'], true);
    }
}
