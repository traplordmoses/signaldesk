# SignalDesk

Newsroom-in-a-bot. SignalDesk pulls news feeds and prediction-market signal, clusters related stories, scores them for relevance, drafts tweets in-house with Claude, and posts the best ones to a Lark review group — each draft carrying a one-click **"🐦 Post on X"** link. There is no auto-posting to X, ever: a human clicks the link, edits in the X composer if needed, and posts.

Sister bot to the BloFin announcement bot; same Lark integration shape, separate codebase to isolate failure domains.

## Link mode (outbound-only)

The Lark surface is **outbound-only**. Review cards carry plain `open_url` "Post on X" link buttons (X intent composer, pre-filled) — **not** callback buttons. Clicking one opens X in the reviewer's browser; it never calls back to the bot, so there's **no inbound webhook, no Card Request URL, nothing to secure inbound**. (Lark's long-connection transport only carries event subscriptions, not card callbacks, and this bot runs on an outbound-only box — so the old Approve/Reject/Edit callback buttons are gone.)

Richer management — approve/reject/edit, history, settings — lives in the **dashboard** (`/review`, `/settings`), which is a normal Next.js UI. On the production box the dashboard binds to localhost and is reached via SSH tunnel; it is not exposed to the internet.

## What it does

```
   every 5 min (node-cron, via Next instrumentation)
        │
        ▼
  fetch news feeds + prediction markets  ──►  cluster + dedupe  ──►  score for relevance
        │
        ▼
  high-scoring cluster?  ──►  Claude drafts 1–N tweet variants (modes: Breaking / News+Odds / Engagement)
        │
        ▼
  post ONE review card to the Lark group   (each draft + a "🐦 Post on X" link)
        │
        ▼
  reviewer taps "Post on X"  ──►  X composer opens pre-filled  ──►  edits, posts (manual)
```

Cron cadence (see `src/lib/cron/scheduler.ts`): fetch + auto-generate every 5 min (≤2 cards/cycle to pace delivery), prune daily at 03:00, prediction-market refresh hourly.

## Stack

- **Next.js 16 / React 19** — the dashboard UI + API routes, and the long-running process that hosts the cron scheduler (via `instrumentation.ts`)
- **better-sqlite3 + drizzle-orm** — one SQLite DB (WAL), kept outside the project tree in prod
- **node-cron** — the fetch / generate / prune / markets schedule
- **@anthropic-ai/sdk** — tweet generation (default model `claude-haiku-4-5-20251001`)
- **systemd** — process management in production (Next standalone server)
- **Outbound-only Lark** — cards out, X intent-links are the action. No inbound Lark webhook.

## Local development

```bash
cp .env.example .env.local
# fill in: ANTHROPIC_API_KEY, LARK_APP_ID / LARK_APP_SECRET / LARK_REVIEW_CHAT_ID,
#          BOT_API_TOKEN (any hex for local), and optionally DB_PATH.

pnpm install      # or npm install
pnpm dev          # dashboard at http://localhost:3000, scheduler boots with it
```

## Lark setup

The bot needs **its own** Lark app (separate from the BloFin bot so you can revoke either independently). Setup is simple in link mode — the bot only ever calls *out*.

1. https://open.larksuite.com → Create Custom App.
2. Permissions: `im:message` + `im:message:send_as_bot`.
3. Add the bot to your review group chat; grab the chat id (`oc_…`) → `LARK_REVIEW_CHAT_ID`.
4. Copy App ID + App Secret → `LARK_APP_ID` / `LARK_APP_SECRET`.
5. Release the app (not draft).

There is **no event subscription, no callback / Request URL, no encryption key, and no verification token** to configure.

## Pausing

Pause/resume the Lark posting either from the dashboard (`/settings`) or, headless on the host, via the CLI — both flip `settings.lark_enabled`, which the scheduler checks before sending each cluster:

```bash
set -a; . /etc/signaldesk.env; set +a    # so DB_PATH + Lark creds resolve
npm run pause     # node scripts/toggle-bot.mjs off
npm run resume    # node scripts/toggle-bot.mjs on
```

## Production deployment (EC2 box, systemd)

Code under `/opt`, env file under `/etc` (chmod 600), DB under `/var/lib`. The app runs as a **Next standalone server bound to localhost** — no nginx, no public ingress.

```bash
# On the server
git clone <repo-url> /opt/signaldesk && cd /opt/signaldesk
cp .env.example /etc/signaldesk.env       # fill in, incl. DB_PATH=/var/lib/signaldesk/signaldesk.db
chmod 600 /etc/signaldesk.env
mkdir -p /var/lib/signaldesk

npm install
scripts/deploy.sh --skip-pull             # build + copy static into standalone + (re)start

cp scripts/signaldesk.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now signaldesk
```

Redeploys: `/opt/signaldesk/scripts/deploy.sh` (graceful stop with WAL checkpoint → pull → build → restart). Reach the dashboard with an SSH tunnel, e.g. `ssh -L 3000:127.0.0.1:3000 <host>` then open `http://localhost:3000`.

**DB safety:** set `DB_PATH` to a path *outside* the project tree (e.g. `/var/lib/signaldesk/signaldesk.db`) — otherwise `next build`'s standalone tracing can clobber the live DB on deploy. Migrations are gated behind `RUN_MIGRATIONS=1` in production.

## What this bot deliberately doesn't do

- ❌ Auto-post to X. Ever. The final post is always a human in the X composer.
- ❌ Run an inbound Lark webhook / Card Request URL. The Lark surface is outbound-only.
- ❌ Put Approve/Reject/Edit/Pause **buttons** on the Lark card — those were callbacks. Review *is* clicking the X link; full management is in the dashboard.
- ❌ Expose the dashboard publicly on the production box (localhost + SSH tunnel only).
- ❌ Share a DB or process with the BloFin bot. Isolation is the point.
