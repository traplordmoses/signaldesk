#!/usr/bin/env bash
#
# SignalDesk production deploy. Run from the server (typically as root).
#
# Pulls latest main, rebuilds, and restarts the systemd service. Requires
# DB_PATH to be set in /etc/signaldesk.env to an absolute path OUTSIDE the
# project tree — otherwise `next build` will trace the project-relative
# data/ directory and clobber the live DB.
#
# Usage:
#   scripts/deploy.sh           # full deploy: pull + build + restart
#   scripts/deploy.sh --skip-pull   # rebuild current checkout (after manual edits)
#
# Safety properties:
#   - graceful stop: relies on the SIGTERM handler in src/lib/cron/scheduler.ts
#     to checkpoint the WAL into the main DB file before exit
#   - defensive checkpoint: also runs `PRAGMA wal_checkpoint(TRUNCATE)` after
#     stop in case the handler didn't fire (older code, hung process, etc)
#   - static-asset copy: Next standalone builds DON'T include .next/static or
#     public/ — they have to be copied in by hand after every build
#   - DB never touched: with DB_PATH outside the project tree, `npm run build`
#     can't see or overwrite the production DB

set -euo pipefail

# EC2 crawler-box convention: code under /opt (the crawler lives at
# /opt/ec2_crawler). Install scripts/signaldesk.service to systemd first.
PROJECT_DIR=/opt/signaldesk
SERVICE=signaldesk
ENV_FILE=/etc/signaldesk.env

cd "$PROJECT_DIR"

# Locate DB_PATH from the environment file. We use this for the defensive
# checkpoint after stop. If unset, we warn and skip the checkpoint — the
# deploy will probably clobber the in-tree DB, but that's a config error
# for the operator to fix, not something we can fix at deploy time.
if [[ -f "$ENV_FILE" ]]; then
  DB_PATH=$(grep -E '^DB_PATH=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
else
  DB_PATH=""
fi

if [[ -z "${DB_PATH:-}" ]]; then
  echo "WARNING: DB_PATH not set in $ENV_FILE — deploy is NOT data-safe."
  echo "         Set DB_PATH to an absolute path outside $PROJECT_DIR and"
  echo "         move the existing DB file to that location before deploying."
fi

echo "=== STOP $SERVICE ==="
systemctl stop "$SERVICE"

if [[ -n "${DB_PATH:-}" && -f "$DB_PATH" ]]; then
  echo "=== DEFENSIVE WAL CHECKPOINT ($DB_PATH) ==="
  sqlite3 "$DB_PATH" 'PRAGMA wal_checkpoint(TRUNCATE);' || true
fi

if [[ "${1:-}" != "--skip-pull" ]]; then
  echo "=== GIT PULL ==="
  git pull --ff-only
fi

echo "=== BUILD ==="
npm run build

echo "=== COPY STATIC ASSETS INTO STANDALONE ==="
# Next standalone bundles only the server entry; static + public have to be
# copied in manually after each build.
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
if [[ -d public ]]; then
  rm -rf .next/standalone/public
  cp -r public .next/standalone/public
fi

echo "=== START $SERVICE ==="
systemctl start "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" && echo "$SERVICE is active" || {
  echo "ERROR: $SERVICE failed to start. Last log lines:"
  journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
}

echo "=== DEPLOY COMPLETE ==="
