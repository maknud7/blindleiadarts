import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const text = path => fs.readFileSync(path, "utf8");
const migration=text("infra/sql/migrations/0089_add_independent_club_elo_periods.php");
const periods=text("apps/api/src/Repository/ClubEloPeriodRepository.php");
const ratings=text("apps/api/src/Repository/ClubEloReadRepository.php");
const api=text("apps/api/src/ClubEloPeriodApplication.php");
const apiIndex=text("apps/api/index.php");
const html=text("apps/admin/index.html");
const admin=text("apps/admin/elo-admin.js");
const season=text("apps/admin/season-admin.js");
const portal=text("apps/player/portal-content.js");
const home=text("apps/player/home-dashboard-ux.js");
const history=text("apps/player/elo-history-exact.js");

test("schema supports one unbounded ELO per club and immutable seasonal history",()=>{
  assert.match(migration, /CREATE TABLE IF NOT EXISTS.*club_elo_periods/s);
  assert.match(migration, /UNIQUE KEY .uniq_club_elo_period_open.*club_id.*open_slot/s);
  assert.match(migration, /CHECK.*ends_on.*starts_on/s);
  assert.doesNotMatch(migration, /DELETE\s+FROM.*elo_match_events/i);
  assert.doesNotMatch(migration, /UPDATE\s+.*elo_current_ratings/i);
  assert.match(migration, /WHERE NOT EXISTS/);
});

test("rollover is atomic and starts exactly one day after the old period ends",()=>{
  assert.match(periods,/begin_transaction\(\)/);
  assert.match(periods,/FOR UPDATE/);
  assert.match(periods,/modify\('\+1 day'\)/);
  assert.match(periods,/SET ends_on=\?,open_slot=NULL/);
  assert.match(periods,/VALUES \(\?,\?,\?,NULL,1\)/);
  assert.match(periods,/elo_period_overlap/);
  assert.match(periods,/historical_lock/);
  assert.match(periods,/->commit\(\)/);
  assert.match(periods,/->rollback\(\)/);
  assert.match(periods,/DateTimeZone\('Europe\/Oslo'\)/);
});

test("club rating derives from completed eligible member matches across season boundaries",()=>{
  assert.match(ratings,/elo_enabled=1 AND m.status="completed"/);
  assert.match(ratings,/t\.club_id=\?/);
  assert.match(ratings,/t\.start_at>=\?/);
  assert.match(ratings,/COALESCE\(pa\.member_id/);
  assert.match(ratings,/COALESCE\(pb\.member_id/);
  assert.match(ratings,/if \(\$a < 1 \|\| \$b < 1 \|\| \$a === \$b\) continue/);
  assert.match(ratings,/new EloCalculator\(\)/);
  assert.match(ratings,/tournament_matches/);
  // Tournament season_id can be returned as metadata but cannot be used to
  // partition or reset the new club ELO calculation.
  assert.doesNotMatch(ratings,/WHERE .*season_id\s*=\s*\?/i);
  assert.doesNotMatch(ratings, /elo_current_ratings|elo_match_events|ranking_snapshots/);
});

test("ELO period mutations are admin only while public rating and history remain GET-only",()=>{
  assert.match(api,/requireClubAdmin\(\$request, \$users, \$clubId\)/);
  assert.match(api,/requireClubAdmin\(\$request, \$users, \(int\) \$period\['club_id'\]\)/);
  assert.match(api,/->bearerToken\(\)/);
  assert.match(api,/club_access_denied/);
  assert.match(api,/club-elo-tournaments/);
  assert.match(api,/elo-periods\/rollover/);
  assert.match(apiIndex,/new ClubEloPeriodApplication/);
  assert.match(apiIndex,/new EloApplication/);
});

test("UX has a separate ELO route, rollover, history and complete player chart",()=>{
  assert.match(html, /href="#elo" data-portal-nav>ELO<\/a>/);
  assert.match(html, /elo-admin\.js/);
  assert.match(admin,/id="eloRolloverForm"/);
  assert.match(admin,/nextDay\(end\)/);
  assert.match(admin,/elo-periods\/rollover/);
  assert.match(admin,/ELO-historikk/);
  assert.match(portal,/\/club-elo/);
  assert.match(home,/club-elo-tournaments/);
  assert.match(home,/clubEloRow/);
  assert.match(history,/club-elo-tournaments/);
  assert.match(season,/administreres separat under ELO/);
  assert.doesNotMatch(season,/<option value="elo">ELO<\/option>/);
});
