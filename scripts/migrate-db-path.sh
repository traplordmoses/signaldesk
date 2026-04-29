#!/usr/bin/env bash
#
# One-time migration: move the SQLite database out of the project tree to
# /var/lib/signaldesk/, so future `next build` runs can't clobber it.
#
# Idempotent — safe to re-run. Skips the move if the destination already
# exists, just verifies the env var is set.
#
# Usage (as root, on the server):
#   scripts/migrate-db-path.sh

set -euo pipefail

OLD_DB=/var/www/signaldesk/.next/standalone/data/signaldesk.db
NEW_DIR=/var/lib/signaldesk
NEW_DB=$NEW_DIR/signaldesk.db
ENV_FILE=/etc/signaldesk.env
SERVICE=signaldesk

# 1. Stop the service so we can move the file safely.
echo "=== STOP $SERVICE ==="
systemctl stop "$SERVICE" || true

# 2. Make the destination dir.
mkdir -p "$NEW_DIR"

# 3. Move (or skip if already migrated).
if [[ -f "$NEW_DB" ]]; then
  echo "DB already at $NEW_DB — skipping move."
elif [[ -f "$OLD_DB" ]]; then
  echo "=== CHECKPOINT WAL ==="
  sqlite3 "$OLD_DB" 'PRAGMA wal_checkpoint(TRUNCATE);' || true

  echo "=== MOVE DB FILES ==="
  mv "$OLD_DB" "$NEW_DB"
  # Move WAL/SHM sidecars too if they exist.
  for sfx in -wal -shm; do
    [[ -f "${OLD_DB}${sfx}" ]] && mv "${OLD_DB}${sfx}" "${NEW_DB}${sfx}"
  done
else
  echo "WARNING: no DB found at $OLD_DB — starting fresh."
fi

# 4. Add or update DB_PATH in the environment file.
if grep -qE '^DB_PATH=' "$ENV_FILE"; then
  sed -i "s|^DB_PATH=.*|DB_PATH=$NEW_DB|" "$ENV_FILE"
  echo "Updated DB_PATH in $ENV_FILE"
else
  printf '\n# DB lives outside the project tree to survive next build\nDB_PATH=%s\n' "$NEW_DB" >> "$ENV_FILE"
  echo "Added DB_PATH to $ENV_FILE"
fi

# 5. Tighten perms — env file has secrets, DB has post content.
chmod 600 "$ENV_FILE" || true
chmod 640 "$NEW_DB" 2>/dev/null || true

# 6. Restart.
echo "=== START $SERVICE ==="
systemctl start "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" && echo "$SERVICE is active" || {
  echo "ERROR: $SERVICE failed to start after migration. Last log lines:"
  journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
}

echo "=== MIGRATION COMPLETE ==="
echo "Active DB: $NEW_DB"
