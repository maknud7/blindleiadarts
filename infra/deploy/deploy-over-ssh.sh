#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <source-dir> <remote-root>" >&2
  exit 1
fi

SOURCE_DIR="$1"
REMOTE_ROOT="$2"
SSH_HOST="login.domeneshop.no"
SSH_USER="ingenting"
SSH_KEY="$HOME/.ssh/domeneshop_deploy"
SSH_OPTS=(
  -i "$SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
)

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Source directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi
if [ ! -f "$SOURCE_DIR/release.json" ]; then
  echo "Release marker missing: $SOURCE_DIR/release.json" >&2
  exit 1
fi

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" "mkdir -p '$REMOTE_ROOT' && test -d '$REMOTE_ROOT'"

# Deploy all release files except release.json first. The release marker is written last,
# so release.json remains the exact proof that the complete deployment finished.
tar -C "$SOURCE_DIR" --exclude='./release.json' -cf - . \
  | ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" "tar -C '$REMOTE_ROOT' -xf -"

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" "cat > '$REMOTE_ROOT/release.json'" \
  < "$SOURCE_DIR/release.json"

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" "test -s '$REMOTE_ROOT/release.json' && ls -la '$REMOTE_ROOT' >/dev/null"

echo "Release deployed over SSH to ${SSH_USER}@${SSH_HOST}:${REMOTE_ROOT}"
