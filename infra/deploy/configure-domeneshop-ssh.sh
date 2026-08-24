#!/usr/bin/env bash
set -euo pipefail

: "${DOMENESHOP_SSH_PRIVATE_KEY:?DOMENESHOP_SSH_PRIVATE_KEY is required}"

SSH_DIR="$HOME/.ssh"
KEY_FILE="$SSH_DIR/domeneshop_deploy"
KNOWN_HOSTS="$SSH_DIR/known_hosts"
HOST="login.domeneshop.no"
EXPECTED_FINGERPRINT="SHA256:1YSqqaqO6iMD9yTbZu3OtMinE9Zw4wZ8siApfBYlOnM"

install -d -m 700 "$SSH_DIR"
printf '%s\n' "$DOMENESHOP_SSH_PRIVATE_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

scan="$(ssh-keyscan -t ed25519 "$HOST" 2>/dev/null)"
if [ -z "$scan" ]; then
  echo "Could not read SSH host key from ${HOST}." >&2
  exit 1
fi

fingerprint="$(printf '%s\n' "$scan" | ssh-keygen -lf - -E sha256 | awk '{print $2}')"
if [ "$fingerprint" != "$EXPECTED_FINGERPRINT" ]; then
  echo "Unexpected SSH fingerprint for Domeneshop: ${fingerprint}" >&2
  exit 1
fi

printf '%s\n' "$scan" > "$KNOWN_HOSTS"
chmod 600 "$KNOWN_HOSTS"

echo "Domeneshop SSH key and host verification configured."
