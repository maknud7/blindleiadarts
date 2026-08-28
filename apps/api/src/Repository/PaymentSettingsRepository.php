<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;

final class PaymentSettingsRepository
{
    private const FIELD_TO_KEY = [
        'stripe_start_url' => 'membership.stripe_start_url',
        'stripe_portal_url' => 'membership.stripe_portal_url',
        'vipps_name' => 'membership.vipps_name',
        'vipps_number' => 'membership.vipps_number',
        'vipps_one_time_url' => 'membership.vipps_one_time_url',
        'payment_contact' => 'membership.payment_contact',
    ];

    private mysqli $connection;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $this->safePrefix($database->tablePrefix());
    }

    /** @return array<string,mixed> */
    public function publicOptions(int $clubId, int $memberId = 0): array
    {
        $club = $this->club($clubId);
        $settings = $this->values($clubId);
        $stripeStart = $this->value($settings, 'membership.stripe_start_url') ?? $this->legacyStripeStartUrl($club);

        return [
            'club_name' => $club['name'] ?? null,
            'stripe_start_url' => $stripeStart,
            'stripe_portal_url' => $this->value($settings, 'membership.stripe_portal_url'),
            'stripe_subscription' => $memberId > 0 ? $this->stripeSubscription($memberId) : null,
            'vipps_name' => $this->value($settings, 'membership.vipps_name') ?? ($club['name'] ?? null),
            'vipps_number' => $this->value($settings, 'membership.vipps_number'),
            'vipps_one_time_url' => $this->value($settings, 'membership.vipps_one_time_url'),
            'payment_contact' => $this->value($settings, 'membership.payment_contact'),
        ];
    }

    /** @return array<string,mixed> */
    public function adminSettings(int $clubId): array
    {
        $club = $this->club($clubId);
        if ($club === null) {
            throw new ValidationException('club_not_found', 'Klubben finnes ikke.', 404);
        }
        $settings = $this->values($clubId);
        $result = [
            'club_id' => $clubId,
            'club_name' => $club['name'],
            'stripe_start_url_effective' => $this->value($settings, 'membership.stripe_start_url') ?? $this->legacyStripeStartUrl($club),
        ];
        foreach (self::FIELD_TO_KEY as $field => $key) {
            $result[$field] = $this->value($settings, $key);
        }
        return $result;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function saveAdminSettings(int $clubId, array $payload): array
    {
        if ($this->club($clubId) === null) {
            throw new ValidationException('club_not_found', 'Klubben finnes ikke.', 404);
        }
        $settingsTable = $this->prefix . 'settings';
        $urlFields = ['stripe_start_url', 'stripe_portal_url', 'vipps_one_time_url'];

        $this->connection->begin_transaction();
        try {
            foreach (self::FIELD_TO_KEY as $field => $key) {
                if (!array_key_exists($field, $payload)) {
                    continue;
                }
                $value = trim((string) ($payload[$field] ?? ''));
                if (in_array($field, $urlFields, true) && $value !== '' && !$this->isHttpUrl($value)) {
                    throw new ValidationException('payment_url_invalid', 'Betalingslenker må være gyldige http- eller https-adresser.', 422);
                }
                if ($field === 'vipps_number' && mb_strlen($value, 'UTF-8') > 50) {
                    throw new ValidationException('vipps_number_invalid', 'Vipps-nummeret er for langt.', 422);
                }
                if (mb_strlen($value, 'UTF-8') > 1000) {
                    throw new ValidationException('payment_setting_too_long', 'En betalingsinnstilling er for lang.', 422);
                }

                if ($value === '') {
                    $delete = $this->connection->prepare("DELETE FROM `{$settingsTable}` WHERE club_id = ? AND setting_key = ?");
                    $delete->bind_param('is', $clubId, $key);
                    $delete->execute();
                    $delete->close();
                    continue;
                }

                $upsert = $this->connection->prepare(
                    "INSERT INTO `{$settingsTable}` (club_id, setting_key, setting_value)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()"
                );
                $upsert->bind_param('iss', $clubId, $key, $value);
                $upsert->execute();
                $upsert->close();
            }
            $this->connection->commit();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $this->adminSettings($clubId);
    }

    /** @return array<string,mixed>|null */
    private function stripeSubscription(int $memberId): ?array
    {
        if (!$this->tableExists('stripe_abonnementer')) {
            return null;
        }
        $stmt = $this->connection->prepare(
            'SELECT status, cancel_at_period_end, ended_at, updated_at
               FROM `stripe_abonnementer`
              WHERE member_id = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT 1'
        );
        $stmt->bind_param('i', $memberId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            return null;
        }
        $status = strtolower(trim((string) ($row['status'] ?? 'unknown')));
        return [
            'status' => $status,
            'active' => in_array($status, ['active', 'trialing'], true),
            'cancel_at_period_end' => (int) ($row['cancel_at_period_end'] ?? 0) === 1,
            'ended_at' => $row['ended_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    /** @return array<string,mixed>|null */
    private function club(int $clubId): ?array
    {
        if ($clubId <= 0) {
            return null;
        }
        $clubs = $this->prefix . 'clubs';
        $stmt = $this->connection->prepare("SELECT id, name, slug FROM `{$clubs}` WHERE id = ? LIMIT 1");
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,string|null> */
    private function values(int $clubId): array
    {
        if ($clubId <= 0) {
            return [];
        }
        $table = $this->prefix . 'settings';
        $stmt = $this->connection->prepare("SELECT setting_key, setting_value FROM `{$table}` WHERE club_id = ?");
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $values = [];
        foreach ($rows as $row) {
            $values[(string) $row['setting_key']] = $row['setting_value'] !== null ? (string) $row['setting_value'] : null;
        }
        return $values;
    }

    /** @param array<string,string|null> $settings */
    private function value(array $settings, string $key): ?string
    {
        $value = trim((string) ($settings[$key] ?? ''));
        return $value !== '' ? $value : null;
    }

    /** @param array<string,mixed>|null $club */
    private function legacyStripeStartUrl(?array $club): ?string
    {
        $name = mb_strtolower((string) ($club['name'] ?? ''), 'UTF-8');
        $slug = mb_strtolower((string) ($club['slug'] ?? ''), 'UTF-8');
        if (str_contains($name, 'blindleia') || str_contains($slug, 'blindleia')) {
            return 'https://dart.ingenting.org/stripe_kontingent.php';
        }
        return null;
    }

    private function tableExists(string $table): bool
    {
        $stmt = $this->connection->prepare(
            'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1'
        );
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_row() !== null;
        $stmt->close();
        return $exists;
    }

    private function isHttpUrl(string $value): bool
    {
        if (filter_var($value, FILTER_VALIDATE_URL) === false) {
            return false;
        }
        $scheme = strtolower((string) parse_url($value, PHP_URL_SCHEME));
        return in_array($scheme, ['http', 'https'], true);
    }

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }
        return $prefix;
    }
}
