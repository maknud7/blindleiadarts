from pathlib import Path

router_path = Path('apps/api/scolia-bridge-router.php')
router = router_path.read_text()
needle = "    if ($request->method() !== 'GET') {\n        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);\n    }\n\n"
insert = needle + "    if ($config->backendV2ScoliaRoutingMode() === 'node') {\n        $client = new \\Blindleia\\Dartkiosk\\Api\\Service\\BackendV2ApiClient(\n            $config->backendV2BaseUrl(),\n            $config->backendV2InternalToken()\n        );\n        $response = $client->request('GET', '/v1/scolia/bridge/router', null, [\n            'x-scolia-bridge-secret' => $providedSecret,\n        ]);\n        $respond($response['payload'], $response['status']);\n    }\n\n"
assert needle in router
router = router.replace(needle, insert, 1)
router_path.write_text(router)

health_path = Path('apps/api/scolia-health.php')
health = health_path.read_text()
needle = "    $config = Config::load(__DIR__);\n    $database = new Database($config);\n"
insert = "    $config = Config::load(__DIR__);\n    if ($config->backendV2ScoliaRoutingMode() === 'node') {\n        $client = new \\Blindleia\\Dartkiosk\\Api\\Service\\BackendV2ApiClient(\n            $config->backendV2BaseUrl(),\n            $config->backendV2InternalToken()\n        );\n        $response = $client->request('GET', '/v1/scolia/health');\n        $respond($response['payload'], $response['status']);\n    }\n    $database = new Database($config);\n"
assert needle in health
health = health.replace(needle, insert, 1)
health_path.write_text(health)

test_path = Path('apps/api/tests/backend_v2_scolia_ops_frontdoor_test.php')
test_path.write_text(r'''<?php

declare(strict_types=1);

$router = file_get_contents(__DIR__ . '/../scolia-bridge-router.php');
$health = file_get_contents(__DIR__ . '/../scolia-health.php');
if (!is_string($router) || !is_string($health)) {
    fwrite(STDERR, "Could not read Scolia operation frontdoors.\n");
    exit(1);
}

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        fwrite(STDERR, $message . "\n");
        exit(1);
    }
};

$assert(str_contains($router, "backendV2ScoliaRoutingMode() === 'node'"), 'Bridge router must use the explicit Scolia Node routing gate.');
$assert(str_contains($router, "'/v1/scolia/bridge/router'"), 'Bridge router must call the backend-v2 router endpoint.');
$assert(str_contains($router, "'x-scolia-bridge-secret' => $providedSecret"), 'Bridge router must validate and forward the incoming bridge secret.');
$assert(strpos($router, "backendV2ScoliaRoutingMode() === 'node'") < strpos($router, 'new Database($config)'), 'Bridge router must decide Node routing before opening the PHP DB path.');
$assert(str_contains($health, "backendV2ScoliaRoutingMode() === 'node'"), 'Health endpoint must use the explicit Scolia Node routing gate.');
$assert(str_contains($health, "'/v1/scolia/health'"), 'Health endpoint must call the backend-v2 health endpoint.');
$assert(strpos($health, "backendV2ScoliaRoutingMode() === 'node'") < strpos($health, 'new Database($config)'), 'Health must decide Node routing before opening the PHP DB path.');
$assert(!str_contains($router, 'allowsPhpFallback'), 'Bridge router must never fall through to PHP after a Node attempt.');
$assert(!str_contains($health, 'allowsPhpFallback'), 'Health must never fall through to PHP after a Node attempt.');

echo "Backend v2 Scolia ops frontdoor contract OK\n";
''')

Path('.github/tmp/apply_scolia_ops_frontdoor.py').unlink()
Path('.github/workflows/tmp-scolia-ops-frontdoor-patch.yml').unlink()
