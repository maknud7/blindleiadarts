import assert from "node:assert/strict";
import fs from "node:fs";

const application = fs.readFileSync("apps/api/src/Application.php", "utf8");
const config = fs.readFileSync("apps/api/src/Support/Config.php", "utf8");
const exampleConfig = fs.readFileSync("apps/api/config.example.php", "utf8");
const deployConfig = fs.readFileSync("infra/deploy/generate_api_config.php", "utf8");
const bootstrap = fs.readFileSync("apps/api/bootstrap.php", "utf8");

assert.doesNotMatch(application, /challonge/i);
assert.doesNotMatch(config, /challonge/i);
assert.doesNotMatch(exampleConfig, /challonge/i);
assert.doesNotMatch(deployConfig, /CHALLONGE_|['"]challonge['"]/i);
assert.doesNotMatch(bootstrap, /Blindleia\\Dartkiosk\\Connectors\\/);

for (const path of [
  "apps/api/src/Service/ChallongeImportService.php",
  "docs/api/CHALLONGE_CONNECTOR.md",
  "packages/connectors/src/Challonge/ChallongeApiClient.php",
  "packages/connectors/src/Challonge/ChallongeConfig.php",
  "packages/connectors/src/Challonge/ChallongeOAuth.php",
  "packages/connectors/src/Challonge/ChallongeOAuthClient.php",
  "packages/connectors/src/Challonge/ChallongeTournamentProvider.php",
  "packages/connectors/src/Contracts/TournamentProviderInterface.php",
]) {
  assert.equal(fs.existsSync(path), false, `Retired Challonge artifact must stay removed: ${path}`);
}

console.log("Retired Challonge runtime contract OK");
