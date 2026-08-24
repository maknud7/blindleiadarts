#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <test|prod>" >&2
  exit 1
fi

ENVIRONMENT="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/$ENVIRONMENT"
RELEASE_SHA="${GITHUB_SHA:-}"

if [[ -z "$RELEASE_SHA" ]]; then
  RELEASE_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
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
copy_dir "$ROOT_DIR/packages" "$OUT_DIR/packages"

mkdir -p "$OUT_DIR/static/club-logos"
mkdir -p "$OUT_DIR/static/sponsors"
mkdir -p "$OUT_DIR/static/players"

if [[ -f "$ROOT_DIR/README.md" ]]; then
  cp "$ROOT_DIR/README.md" "$OUT_DIR/README.md"
fi

if [[ -f "$ROOT_DIR/index.html" ]]; then
  cp "$ROOT_DIR/index.html" "$OUT_DIR/index.html"
fi

printf '{"environment":"%s","sha":"%s"}\n' "$ENVIRONMENT" "$RELEASE_SHA" > "$OUT_DIR/release.json"

echo "Built release package at $OUT_DIR (sha=$RELEASE_SHA)"
