<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;
use Throwable;

/**
 * Accepts a bridge event only when the canonical physical serial and the routed
 * runtime kiosk agree. This is the boundary that allows one physical PROD Scolia
 * to feed an isolated TEST match during an explicit lease.
 */
final class ScoliaRoutedEventRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $hardwarePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $database->tablePrefix();
        $this->hardwarePrefix = $database->hardwareTablePrefix();
    }

    /** @param array<string,mixed> $message @return array{id:int,duplicate:bool} */
    public function enqueueEvent(string $serial, int $routedKioskId, array $message): array
    {
        $serial = strtoupper(trim($serial));
        if ($serial === '' || $routedKioskId <= 0) {
            throw new ValidationException('scolia_route_invalid', 'Scolia-eventet mangler canonical serial eller routed kiosk.', 422);
        }

        $physical = $this->physicalBoardBySerial($serial);
        if ($physical === null) {
            throw new ValidationException('scolia_board_not_mapped', 'Scolia-serienummeret er ikke koblet til en fysisk PROD-skive.', 404);
        }

        $physicalId = (int) $physical['physical_kiosk_id'];
        $clubId = 0;
        if ($this->dataPrefix === $this->hardwarePrefix) {
            if ($routedKioskId !== $physicalId) {
                throw new ValidationException('scolia_route_mismatch', 'Scolia-eventet peker på feil fysisk PROD-skive.', 409);
            }
            $clubId = (int) $physical['club_id'];
        } else {
            $stmt = $this->connection->prepare(sprintf(
                'SELECT k.club_id,c.slug FROM `%1$skiosks` k
                 INNER JOIN `%1$sclubs` c ON c.id=k.club_id
                 WHERE k.id=? AND k.source_kiosk_id=? AND k.is_active=1 LIMIT 1',
                $this->dataPrefix
            ));
            $stmt->bind_param('ii', $routedKioskId, $physicalId);
            $stmt->execute();
            $runtime = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($runtime === null || trim((string) ($runtime['slug'] ?? '')) !== trim((string) ($physical['club_slug'] ?? ''))) {
                throw new ValidationException('scolia_test_lease_route_invalid', 'TEST-routen samsvarer ikke med den canonical fysiske Scolia-skiva.', 409);
            }
            $clubId = (int) $runtime['club_id'];
        }

        $providerId = trim((string) ($message['id'] ?? ''));
        $type = strtoupper(trim((string) ($message['type'] ?? 'UNKNOWN')));
        $payload = is_array($message['payload'] ?? null) ? $message['payload'] : [];
        $dedupeBasis = $providerId !== ''
            ? 'id:' . $serial . ':' . $providerId
            : 'payload:' . $serial . ':' . $type . ':' . json_encode($message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $dedupeKey = hash('sha256', $dedupeBasis);
        $payloadJson = json_encode($message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $detectedAt = $this->providerDateTime($payload['detectionTime'] ?? $payload['detection_time'] ?? null);
        $matchId = $this->activeMatchId($routedKioskId);

        $stmt = $this->connection->prepare(sprintf(
            'INSERT IGNORE INTO `%1$sscolia_events`
             (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,provider_detected_at,payload_json)
             VALUES (?,?,?,?,?,?,?,?)',
            $this->dataPrefix
        ));
        $providerIdValue = $providerId !== '' ? $providerId : null;
        $stmt->bind_param('iiisssss', $clubId, $routedKioskId, $matchId, $providerIdValue, $dedupeKey, $type, $detectedAt, $payloadJson);
        $stmt->execute();
        $inserted = $stmt->affected_rows > 0;
        $id = $inserted ? (int) $stmt->insert_id : 0;
        $stmt->close();

        if (!$inserted) {
            $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$sscolia_events` WHERE dedupe_key=? LIMIT 1', $this->dataPrefix));
            $stmt->bind_param('s', $dedupeKey);
            $stmt->execute();
            $id = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
            $stmt->close();
        }

        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,last_event_at) VALUES (?,NOW(3))
             ON DUPLICATE KEY UPDATE last_event_at=NOW(3)',
            $this->dataPrefix
        ));
        $stmt->bind_param('i', $routedKioskId);
        $stmt->execute();
        $stmt->close();

        return ['id' => $id, 'duplicate' => !$inserted];
    }

    /** @return array<string,mixed>|null */
    private function physicalBoardBySerial(string $serial): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT k.id AS physical_kiosk_id,k.club_id,c.slug AS club_slug,s.serial_number,s.mode,
                    cs.enabled,cs.access_token
             FROM `%1$sscolia_board_settings` s
             INNER JOIN `%1$skiosks` k ON k.id=s.kiosk_id AND k.is_active=1
             INNER JOIN `%1$sclubs` c ON c.id=k.club_id
             INNER JOIN `%1$sscolia_club_settings` cs ON cs.club_id=k.club_id AND cs.enabled=1
             WHERE UPPER(s.serial_number)=? AND s.mode IN ("shadow","live")
               AND cs.access_token IS NOT NULL AND cs.access_token<>"" LIMIT 1',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('s', $serial);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function activeMatchId(int $kioskId): ?int
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id FROM `%1$smatches` WHERE kiosk_id=? AND status IN ("in_progress","assigned")
             ORDER BY FIELD(status,"in_progress","assigned"),id LIMIT 1',
            $this->dataPrefix
        ));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $value = $stmt->get_result()->fetch_assoc()['id'] ?? null;
        $stmt->close();
        return $value === null ? null : (int) $value;
    }

    private function providerDateTime(mixed $value): ?string
    {
        if (!is_string($value) || trim($value) === '') return null;
        try {
            return (new DateTimeImmutable($value))->format('Y-m-d H:i:s.v');
        } catch (Throwable) {
            return null;
        }
    }
}
