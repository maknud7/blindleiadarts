<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Application;

require __DIR__ . '/bootstrap.php';

$app = new Application(__DIR__);
$app->run();
