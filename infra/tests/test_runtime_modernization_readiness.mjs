import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const generator = read("infra/deploy/generate_api_config.php");
for (const expected of [
  "$defaultBackendV2ScoliaRoutingMode = ($isTest || $isProd) ? 'node' : 'php';",
  "$defaultBackendV2TournamentRoutingMode = $isTest ? 'node' : 'php';",
  "$defaultBackendV2PlayerLiveRoutingMode = ($isTest || $isProd) ? 'node' : 'php';",
  "$defaultBackendV2AccountReadRoutingMode = ($isTest || $isProd) ? 'node' : 'php';",
  "$defaultBackendV2AccountMutationRoutingMode = $isTest ? 'node' : 'php';",
  "$defaultBackendV2ActivityRoutingMode = $isTest ? 'node' : 'php';",
  "$defaultBackendV2PaymentSettingsRoutingMode = $isTest ? 'node' : 'php';",
  "$defaultBackendV2IdentityAuditRoutingMode = ($isTest || $isProd) ? 'node' : 'php';",
  "$defaultBackendV2ClubAdminRoutingMode = $isTest ? 'node' : 'php';",
  "$defaultBackendV2SystemStatusRoutingMode = ($isTest || $isProd) ? 'node' : 'php';",
]) assert.ok(generator.includes(expected), `Missing TEST Node default: ${expected}`);

const deployTest = read(".github/workflows/deploy-test.yml");
assert.ok(deployTest.includes("BACKEND_V2_EQUIPMENT_ROUTING_MODE: node"));
assert.ok(deployTest.includes("DB_TABLE_PREFIX: bd_test_"));
assert.ok(deployTest.includes("IDENTITY_TABLE_PREFIX: bd_prod_"));
assert.ok(deployTest.includes("HARDWARE_TABLE_PREFIX: bd_prod_"));

const index = read("apps/api/index.php");
const mutationProxy = index.indexOf("$accountMutationV2 = new BackendV2AccountMutationProxyApplication");
assert.ok(mutationProxy >= 0);
assert.ok(mutationProxy < index.indexOf("$passwordReset = new PasswordResetApplication"));
assert.ok(mutationProxy < index.indexOf("$emailAuth = new EmailAuthApplication"));
assert.ok(mutationProxy < index.indexOf("$accountProfile = new AccountProfileApplication"));

const accountMutation = read("apps/api/src/BackendV2AccountMutationProxyApplication.php");
for (const route of ["/v1/auth/login","/v1/me/profile","/v1/me/password","/v1/auth/password-reset/request","/v1/auth/password-reset/confirm"]) {
  assert.ok(accountMutation.includes(route), `Missing TEST account mutation route: ${route}`);
}

const authRepo = read("apps/backend-v2/src/mysql/identity-auth-repository.ts");
assert.ok(authRepo.includes("INSERT INTO \\`${this.runtimePrefix}auth_sessions\\`"));
assert.ok(authRepo.includes("sessionPrefix === this.runtimePrefix"));
assert.equal(authRepo.includes("INSERT INTO \\`${this.identityPrefix}auth_sessions\\`"), false);

const clubProxy = read("apps/api/src/BackendV2ClubAdminProxyApplication.php");
assert.ok(clubProxy.includes("players$#"));
const clubRepo = read("apps/backend-v2/src/mysql/club-admin-repository.ts");
assert.ok(clubRepo.includes("createLocalPlayer"));
assert.ok(clubRepo.includes("test_identity_fields_not_allowed"));

const identitySelector = read("apps/api/src/PlayerIdentityApplication.php");
assert.ok(identitySelector.includes("routeMergeToNode"));
assert.ok(identitySelector.includes("appEnv() === 'test'"));
const identityRouter = read("apps/backend-v2/src/runtime/identity-audit-read-router.ts");
assert.ok(identityRouter.includes("player_identity_merge_prod_only"));

// Active kiosk post-match operations must not fall through to legacy PHP in TEST.
const tournamentProxy = read("apps/api/src/BackendV2TournamentProxyApplication.php");
const kioskOperations = read("apps/kiosk/operations-runtime.js");
for (const route of ["post-match","next-match","release-next-match"]) {
  assert.ok(kioskOperations.includes(route), `Expected active kiosk operation in frontend: ${route}`);
  assert.ok(tournamentProxy.includes(route), `Active kiosk operation is not captured by Node frontdoor: ${route}`);
}
assert.ok(tournamentProxy.includes("x-kiosk-pairing-token"), "Tournament frontdoor must forward kiosk pairing token.");

const migration = read("infra/sql/migrations/0088_isolate_test_auth_sessions.php");
assert.ok(migration.includes("bd_test_"));
assert.ok(migration.includes("DROP FOREIGN KEY"));

for (const root of ["apps","packages"]) scan(root, (path) => {
  if (!/\.(?:js|mjs|html)$/.test(path)) return;
  assert.equal(read(path).includes("/v1/kiosks/pair"), false, `Retired kiosk pair route still referenced by ${path}`);
});

console.log("TEST_RUNTIME_MODERNIZATION_READY=yes");

function scan(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) scan(path, visit);
    else if (entry.isFile()) visit(path);
  }
}