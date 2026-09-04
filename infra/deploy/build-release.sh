#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <test|prod>" >&2
  exit 1
fi

ENVIRONMENT="$1"
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Environment must be test or prod" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/$ENVIRONMENT"

# The release marker must describe the commit that is actually checked out.
# GITHUB_SHA describes the triggering event and can differ for a production
# release-request workflow that subsequently checks out an immutable RC SHA.
RELEASE_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$RELEASE_SHA" ]]; then
  RELEASE_SHA="${GITHUB_SHA:-}"
fi
if [[ -z "$RELEASE_SHA" ]]; then
  RELEASE_SHA="unknown"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

copy_dir() {
  local source="$1"
  local target="$2"

  if [[ -d "$source" ]]; then
    cp -R "$source" "$target"
  else
    mkdir -p "$target"
  fi
}

copy_dir "$ROOT_DIR/apps/api" "$OUT_DIR/api"
copy_dir "$ROOT_DIR/apps/kiosk" "$OUT_DIR/kiosk"
copy_dir "$ROOT_DIR/apps/screen" "$OUT_DIR/screen"
copy_dir "$ROOT_DIR/apps/admin" "$OUT_DIR/admin"
copy_dir "$ROOT_DIR/apps/player" "$OUT_DIR/player"
copy_dir "$ROOT_DIR/apps/live" "$OUT_DIR/live"
copy_dir "$ROOT_DIR/apps/onboarding" "$OUT_DIR/onboarding"
copy_dir "$ROOT_DIR/packages" "$OUT_DIR/packages"

# Historical source probes are deliberately available in TEST while history is
# being migrated. They are migration tooling, not application runtime, and must
# never be shipped in a production release.
if [[ "$ENVIRONMENT" == "prod" ]]; then
  rm -f \
    "$OUT_DIR/api/atlas-import-probe.php" \
    "$OUT_DIR/api/atlas-match-visits.php" \
    "$OUT_DIR/api/atlas-migrate-test.php" \
    "$OUT_DIR/api/atlas-season-probe.php" \
    "$OUT_DIR/api/atlas-tournament-probe.php"
fi

mkdir -p "$OUT_DIR/static"
copy_dir "$ROOT_DIR/static/club-logos" "$OUT_DIR/static/club-logos"
copy_dir "$ROOT_DIR/static/sponsors" "$OUT_DIR/static/sponsors"
copy_dir "$ROOT_DIR/static/players" "$OUT_DIR/static/players"

# README is useful in TEST for migration/support work, but it is documentation,
# not production runtime and can contain references to retired providers.
if [[ "$ENVIRONMENT" == "test" && -f "$ROOT_DIR/README.md" ]]; then
  cp "$ROOT_DIR/README.md" "$OUT_DIR/README.md"
fi

if [[ -f "$ROOT_DIR/index.html" ]]; then
  cp "$ROOT_DIR/index.html" "$OUT_DIR/index.html"
fi

# / is the canonical browser entry. /player/ and /admin/ remain deployed as
# compatibility bundles only; direct browser visits return to the root.
for html in "$OUT_DIR/player/index.html" "$OUT_DIR/admin/index.html"; do
  [[ -f "$html" ]] || continue
  if ! grep -Fq '/packages/ui-assets/canonical-entry.js' "$html"; then
    php -r '
      $path = $argv[1];
      $html = file_get_contents($path);
      if ($html === false) { exit(1); }
      $tag = "\n  <script src=\"/packages/ui-assets/canonical-entry.js?v=20260827-1745\"></script>";
      $updated = preg_replace("/<head>/", "<head>" . $tag, $html, 1, $count);
      if ($updated === null || $count !== 1) { fwrite(STDERR, "Could not inject canonical entry into {$path}\n"); exit(1); }
      file_put_contents($path, $updated);
    ' "$html"
  fi
done

# Phase 1 UI foundation: every browser surface receives the same tokens and
# component vocabulary. Surface-specific CSS keeps kiosk/venue geometry intact.
while IFS='|' read -r surface html; do
  [[ -n "$surface" && -f "$html" ]] || continue
  php -r '
    $path = $argv[1];
    $surface = $argv[2];
    $html = file_get_contents($path);
    if ($html === false) { exit(1); }
    if (strpos($html, "/packages/ui-assets/blindleia-system.css") === false) {
      $tags = "  <link rel=\"stylesheet\" href=\"/packages/ui-assets/brand-tokens.css?v=20260827-1745\">\n"
            . "  <link rel=\"stylesheet\" href=\"/packages/ui-assets/blindleia-system.css?v=20260827-1745\">\n";
      $html = str_replace("</head>", $tags . "</head>", $html, $count);
      if ($count !== 1) { fwrite(STDERR, "Could not inject design system into {$path}\n"); exit(1); }
    }
    if (preg_match("/<body([^>]*)>/i", $html, $match)) {
      $attrs = $match[1];
      if (stripos($attrs, "data-bd-surface=") === false) {
        $replacement = "<body" . $attrs . " data-bd-surface=\"" . htmlspecialchars($surface, ENT_QUOTES) . "\">";
        $html = preg_replace("/<body([^>]*)>/i", $replacement, $html, 1, $count);
        if ($html === null || $count !== 1) { fwrite(STDERR, "Could not mark surface in {$path}\n"); exit(1); }
      }
    }
    file_put_contents($path, $html);
  ' "$html" "$surface"
done <<EOF
admin|$OUT_DIR/admin/index.html
player|$OUT_DIR/player/index.html
kiosk|$OUT_DIR/kiosk/index.html
live|$OUT_DIR/live/index.html
screen|$OUT_DIR/screen/index.html
onboarding|$OUT_DIR/onboarding/index.html
EOF

# Canonical identity management belongs to the common admin shell, but remains
# a separate feature bundle so it can be retired independently after the legacy
# admin bundle is fully decomposed.
if [[ -f "$OUT_DIR/admin/index.html" ]]; then
  php -r '
    $path = $argv[1];
    $html = file_get_contents($path);
    if ($html === false) { exit(1); }
    if (strpos($html, "player-identity-admin.css") === false) {
      $html = str_replace("</head>", "  <link rel=\"stylesheet\" href=\"/admin/player-identity-admin.css?v=20260827-1745\">\n</head>", $html, $count);
      if ($count !== 1) { fwrite(STDERR, "Could not inject player identity CSS.\n"); exit(1); }
    }
    if (strpos($html, "player-identity-admin.js") === false) {
      $html = str_replace("</body>", "  <script type=\"module\" src=\"/admin/player-identity-admin.js?v=20260827-1745\"></script>\n</body>", $html, $count);
      if ($count !== 1) { fwrite(STDERR, "Could not inject player identity JS.\n"); exit(1); }
    }
    file_put_contents($path, $html);
  ' "$OUT_DIR/admin/index.html"
fi

# TEST may use physical boards but must never mutate their canonical PROD
# masterdata. Inject a TEST-only UI guard; the API independently enforces the
# same boundary so this is UX, not the security/control boundary.
if [[ "$ENVIRONMENT" == "test" && -f "$OUT_DIR/admin/index.html" ]]; then
  php -r '
    $path = $argv[1];
    $html = file_get_contents($path);
    if ($html === false) { exit(1); }
    if (strpos($html, "test-hardware-readonly.js") === false) {
      $tag = "  <script type=\"module\" src=\"/admin/test-hardware-readonly.js?v=20260903-0715\"></script>\n";
      $html = str_replace("</body>", $tag . "</body>", $html, $count);
      if ($count !== 1) { fwrite(STDERR, "Could not inject TEST hardware read-only guard.\n"); exit(1); }
    }
    file_put_contents($path, $html);
  ' "$OUT_DIR/admin/index.html"
fi

# First-party activity telemetry is injected into every browser surface in the
# release. It does not create an analytics cookie or persistent anonymous ID.
for html in \
  "$OUT_DIR/index.html" \
  "$OUT_DIR/admin/index.html" \
  "$OUT_DIR/player/index.html" \
  "$OUT_DIR/live/index.html" \
  "$OUT_DIR/screen/index.html" \
  "$OUT_DIR/kiosk/index.html" \
  "$OUT_DIR/onboarding/index.html"; do
  [[ -f "$html" ]] || continue
  if ! grep -Fq '/packages/ui-assets/activity.js' "$html"; then
    php -r '
      $path = $argv[1];
      $html = file_get_contents($path);
      if ($html === false) { exit(1); }
      $tag = "  <script type=\"module\" src=\"/packages/ui-assets/activity.js\"></script>\n";
      $updated = str_replace("</body>", $tag . "</body>", $html, $count);
      if ($count !== 1) { fwrite(STDERR, "Could not inject activity tracker into {$path}\n"); exit(1); }
      file_put_contents($path, $updated);
    ' "$html"
  fi
done

# Make the deployed kiosk environment explicit without dropping the canonical
# surface marker added above.
if [[ -f "$OUT_DIR/kiosk/index.html" ]]; then
  php -r '
    $path = $argv[1];
    $env = $argv[2];
    $html = file_get_contents($path);
    if ($html === false) {
        fwrite(STDERR, "Could not read kiosk index.\n");
        exit(1);
    }
    $updated = preg_replace_callback("/<body([^>]*)>/i", static function (array $m) use ($env): string {
        $attrs = $m[1];
        $attrs = preg_replace("/\\sdata-app-env=([\"\x27]).*?\\1/i", "", $attrs) ?? $attrs;
        return "<body" . $attrs . " data-app-env=\"" . htmlspecialchars($env, ENT_QUOTES) . "\">";
    }, $html, 1, $count);
    if ($updated === null || $count !== 1) {
        fwrite(STDERR, "Could not embed kiosk app environment.\n");
        exit(1);
    }
    file_put_contents($path, $updated);
  ' "$OUT_DIR/kiosk/index.html" "$ENVIRONMENT"
fi

printf '{"environment":"%s","sha":"%s"}\n' "$ENVIRONMENT" "$RELEASE_SHA" > "$OUT_DIR/release.json"

echo "Built release package at $OUT_DIR (sha=$RELEASE_SHA, env=$ENVIRONMENT)"
