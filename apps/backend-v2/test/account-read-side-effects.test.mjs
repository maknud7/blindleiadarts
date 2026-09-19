import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/server.ts", import.meta.url);

const accountReadRoutes = [
  "/v1/auth/me",
  "/v1/me/profile",
  "/v1/me/payments",
  "/v1/me/eligibility",
];

test("authenticated account GET routes never touch identity sessions", async () => {
  const source = await readFile(sourceUrl, "utf8");

  for (const route of accountReadRoutes) {
    const marker = `if (method === \"GET\" && publicPath === \"${route}\") {`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `missing account-read route ${route}`);

    const nextRoute = source.indexOf("\n  if (", start + marker.length);
    const block = source.slice(start, nextRoute === -1 ? source.length : nextRoute);

    assert.match(
      block,
      /requireIdentityUser\(request, false\)/,
      `${route} must resolve the session without touching last_seen`,
    );
    assert.doesNotMatch(
      block,
      /requireIdentityUser\(request, identityTouchAllowed\(\)\)/,
      `${route} must stay side-effect-free even when PROD is write-armed for other domains`,
    );
  }
});


test("auth/me formats BIGINT identity ids as exact decimal strings", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const start = source.indexOf("function formatPublicUser(user: IdentityUser)");
  assert.notEqual(start, -1, "missing formatPublicUser");
  const end = source.indexOf("\nfunction safeIdString", start);
  assert.notEqual(end, -1, "missing safeIdString boundary");
  const block = source.slice(start, end);

  assert.match(block, /id: safeIdString\(user\.id\)/);
  assert.match(block, /id: safeIdString\(user\.player_id\)/);
  assert.match(block, /club_id: safeIdString\(user\.player_club_id\)/);
  assert.doesNotMatch(source, /safePublicNumber/);
});
