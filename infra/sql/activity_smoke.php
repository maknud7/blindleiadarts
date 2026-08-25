<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ActivityRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

$config = Config::load(dirname(__DIR__, 2) . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();
$repo = new ActivityRepository($database);

$club = $db->query("SELECT id,slug FROM `{$prefix}clubs` ORDER BY id LIMIT 1")->fetch_assoc() ?: null;
if ($club === null || (int) ($club['id'] ?? 0) <= 0 || trim((string) ($club['slug'] ?? '')) === '') {
    throw new RuntimeException('Activity smoke requires one club with slug.');
}
$clubId = (int) $club['id'];
$clubSlug = (string) $club['slug'];

$db->begin_transaction();
try {
    $recorded = $repo->recordBatch([
        [
            'surface' => 'live',
            'event_name' => 'page_view',
            'path' => '/live/',
            'page_title' => 'Activity smoke',
            'device_class' => 'mobile',
            'club_slug' => $clubSlug,
            'metadata' => ['source' => 'smoke'],
        ],
        [
            'surface' => 'admin',
            'event_name' => 'click',
            'path' => '/admin/#overview',
            'club_id' => $clubId,
            'metadata' => ['element_id' => 'smoke-button'],
        ],
    ], null, null);
    if ($recorded !== 2) {
        throw new RuntimeException('Expected two recorded activity events.');
    }

    $stmt = $db->prepare("SELECT COUNT(*) AS c FROM `{$prefix}activity_events` WHERE club_id=? AND page_title='Activity smoke'");
    $stmt->bind_param('i', $clubId);
    $stmt->execute();
    $count = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0);
    $stmt->close();
    if ($count !== 1) {
        throw new RuntimeException('Club slug was not resolved for activity event.');
    }

    $summary = $repo->summaryByClub($clubId, 1);
    if ((int) ($summary['totals']['events'] ?? 0) < 2) {
        throw new RuntimeException('Activity summary did not include recorded events.');
    }

    echo "ACTIVITY_SMOKE_OK=yes\n";
    $db->rollback();
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
}
