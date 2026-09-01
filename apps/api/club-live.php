<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'GET kreves.']], 405);
    }

    $config = Config::load(__DIR__);
    $database = new Database($config);
    $connection = $database->connection();
    $table = $database->tablePrefix() . 'clubs';

    $code = trim((string) ($_GET['code'] ?? ''));
    $clubId = (int) ($_GET['club_id'] ?? 0);

    if ($code !== '') {
        if (preg_match('/^\d{4}$/', $code) !== 1) {
            $respond(['ok' => false, 'error' => ['code' => 'invalid_live_code', 'message' => 'Live-koden må være fire sifre.']], 422);
        }
        $statement = $connection->prepare(
            sprintf('SELECT id, name, slug, live_code, live_display_profile FROM `%s` WHERE live_code = ? LIMIT 1', $table)
        );
        $statement->bind_param('s', $code);
    } elseif ($clubId > 0) {
        $statement = $connection->prepare(
            sprintf('SELECT id, name, slug, live_code, live_display_profile FROM `%s` WHERE id = ? LIMIT 1', $table)
        );
        $statement->bind_param('i', $clubId);
    } else {
        $respond(['ok' => false, 'error' => ['code' => 'club_required', 'message' => 'Oppgi Live-kode eller klubb.']], 422);
    }

    $statement->execute();
    $club = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($club === null) {
        $respond(['ok' => false, 'error' => ['code' => 'club_not_found', 'message' => 'Fant ikke klubben for denne Live-lenken.']], 404);
    }

    $liveCode = trim((string) ($club['live_code'] ?? ''));
    if ($liveCode === '' && $clubId > 0) {
        // New clubs created by an older creation path receive their permanent
        // public code on first admin access. A unique index protects collisions.
        for ($attempt = 0; $attempt < 30; $attempt++) {
            $candidate = (string) random_int(1000, 9999);
            $exists = $connection->prepare(
                sprintf('SELECT id FROM `%s` WHERE live_code = ? LIMIT 1', $table)
            );
            $exists->bind_param('s', $candidate);
            $exists->execute();
            $taken = $exists->get_result()->fetch_row() !== null;
            $exists->close();
            if ($taken) {
                continue;
            }

            $update = $connection->prepare(
                sprintf('UPDATE `%s` SET live_code = ? WHERE id = ? AND (live_code IS NULL OR live_code = "")', $table)
            );
            $id = (int) $club['id'];
            $update->bind_param('si', $candidate, $id);
            $update->execute();
            $changed = $update->affected_rows > 0;
            $update->close();

            if ($changed) {
                $liveCode = $candidate;
                break;
            }

            $reload = $connection->prepare(
                sprintf('SELECT live_code FROM `%s` WHERE id = ? LIMIT 1', $table)
            );
            $reload->bind_param('i', $id);
            $reload->execute();
            $row = $reload->get_result()->fetch_assoc() ?: [];
            $reload->close();
            $liveCode = trim((string) ($row['live_code'] ?? ''));
            if ($liveCode !== '') {
                break;
            }
        }
    }

    if (preg_match('/^\d{4}$/', $liveCode) !== 1) {
        throw new RuntimeException('Klubben mangler gyldig Live-kode.');
    }

    $profile = trim((string) ($club['live_display_profile'] ?? 'blindleia'));
    if (!in_array($profile, ['blindleia', 'broadcast-dark'], true)) {
        $profile = 'blindleia';
    }

    $baseUrl = rtrim($config->baseUrl(), '/');
    $respond(['ok' => true, 'data' => [
        'club' => [
            'id' => (int) $club['id'],
            'name' => (string) $club['name'],
            'slug' => (string) $club['slug'],
            'live_code' => $liveCode,
            'live_display_profile' => $profile,
        ],
        'live_url' => $baseUrl . '/live/' . $liveCode,
    ]]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'club_live_unavailable',
            'message' => 'Kunne ikke hente klubbens Live-lenke.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
