# HANDOFF — Probly Bots: EC2 Migration + Legal Redline Integration

_For whoever picks this up next (e.g. an agent on the work laptop). Self-contained — assumes no prior context._

## TL;DR
Two Node bots — **SignalDesk** (= the Probly X News Bot) and **Blofin** (BloFin announcement bot) — are being moved off a DigitalOcean droplet onto the work **EC2 crawler box**, and converted to **"link mode"** (outbound-only Lark). A flag-gated **Legal Redline review shim** is pre-built on the News Bot. Everything is committed + pushed to GitHub under **traplordmoses**. Your jobs: **(1)** deploy the link-mode branches to EC2 and cut over; **(2)** when the Legal Agent API lands, flip the legal shim live.

## Repos & account
- GitHub account: **traplordmoses** (NOT `dripwarts-cloud` — that account isn't reachable from the personal laptop; both SSH keys and the `gh` CLI authenticate as traplordmoses).
  - `traplordmoses/signaldesk` — News Bot (Next.js app + dashboard + cron scheduler)
  - `traplordmoses/blofin-announcement-bot` — announcement bot (pure node-cron worker)
- Clone: `gh repo clone traplordmoses/signaldesk` and `gh repo clone traplordmoses/blofin-announcement-bot`.

## Branches & PRs (merge order matters)
| Repo | Branch | PR | Contains |
|---|---|---|---|
| signaldesk | `ec2-linkmode` | #1 | link-mode conversion |
| signaldesk | `legal-redline-shim` | #2 (base `ec2-linkmode`) | legal review shim, **stacked on #1** |
| blofin | `ec2-linkmode` | #1 | link-mode conversion |

The deployable tip for signaldesk is **`legal-redline-shim`** (it includes link mode + the legal shim). Merge order: **#1 then #2**.

## What "link mode" is (and why)
The bots used interactive Lark card **buttons** (Approve/Reject/Edit/Pause) = `card.action.trigger` **callbacks**, which require an inbound HTTPS Card Request URL. The EC2 box is **outbound-only**, and Lark's long-connection (WebSocket) transport carries *events* but **not** card callbacks — so buttons can't work there. Fix: replace callback buttons with a plain `open_url` **"🐦 Post on X"** link (opens X's intent composer, pre-filled). The reviewer's click *is* the approval; wording edits happen in the X composer; ignoring a card skips it.
- **Blofin** → pure node-cron worker (no HTTP server at all).
- **SignalDesk** → keeps its Next.js dashboard, but it binds to **localhost** on EC2 (reach via SSH tunnel). Only the Lark *callback route* was removed; the dashboard + its API routes stay.
- Pause/resume is now a **host CLI** on both (`npm run pause` / `npm run resume`).

## JOB 1 — Deploy to EC2 + cut over
Follow each repo's README → "Production deployment" (code under `/opt/<bot>`, env at `/etc/<bot>.env` chmod 600, DB under `/var/lib/<bot>`, systemd units in `scripts/`). Cutover sequence:

1. **Stop the droplet services FIRST** — on `root@67.205.179.227`: `systemctl stop signaldesk blofin-bot`. Both bots share their Lark app, so running droplet + EC2 simultaneously **double-posts every card**.
2. *(Recommended)* Copy the SQLite DBs droplet → EC2 to preserve tuned settings + dedup history:
   `scp /var/lib/signaldesk/signaldesk.db* <ec2>:/var/lib/signaldesk/` (and the blofin DB). Point `DB_PATH` at them. This preserves SignalDesk's threshold / dailyPostLimit and Blofin's `processed_announcements` (so you can skip `BLOFIN_PROCESS_AFTER`).
3. If NOT copying the Blofin DB: set `BLOFIN_PROCESS_AFTER=<cutover ISO timestamp>` so it doesn't miss or re-spam announcements.
4. Build + start the systemd services on EC2 (after first-time setup, redeploys are `scripts/deploy.sh`).
5. **Validate** — `journalctl -u signaldesk -f`; confirm a review card posts to the Lark group with a working "🐦 Post on X" link.
6. In each Lark app console, **remove the Card Request URL** (unused in link mode).
7. Once validated, merge PRs #1 (both repos) + #2, then retire the droplet.

## JOB 2 — Verify live (the one thing untested)
The card render + X-intent-link round-trip can't be exercised without live Lark creds. On first EC2 deploy, confirm: a review card appears in the Lark group, and the "Post on X" button opens X with the tweet pre-filled.

## JOB 3 — Legal Redline integration (when John Tang's API lands)
The News-Bot side is built and **flag-gated (off by default)**. Full scope + contract: `signaldesk/LEGAL_REDLINE_INTEGRATION.md`. Team summary to paste in Lark: `signaldesk/LEGAL_LARK_SUMMARY.md`.
- **Try it now (stub):** set `LEGAL_REVIEW_ENABLED=1` (stub mode auto-engages with no URL). The next generated cluster's Lark card shows a `⚖️ Legal` verdict block (pass / flag / block).
- **Go live:** set `LEGAL_REVIEW_URL` (+ `LEGAL_REVIEW_TOKEN`), then adjust `toWire()` / `fromWire()` in `src/lib/legal/client.ts` to John's final schema — that's the only code change needed.
- **Fail-open:** a Legal Agent timeout/5xx never blocks a post (verdict `error`, card shows "review unavailable").
- **Open questions for John** (block going live): §7 of the integration doc — endpoint/auth, request/response schema, image-input format, sync vs async + latency, fail behavior, redline-vs-verdict, comments handling.

## Gotchas / context
- **Never run droplet + EC2 bots at the same time** (shared Lark app → duplicate cards).
- **Droplet logs:** not reachable from the personal laptop (no SSH key authorized there — both auth as traplordmoses, the droplet rejects). Health was instead verified via the SignalDesk dashboard API and was green (68 sources, ~116 items/hr, live Lark approvals, sitting at its 50/day cap). For journalctl you'll need a key actually authorized on the droplet.
- **EC2 box** = a Python crawler (`/opt/ec2_crawler`, systemd, outbound-only via an S3 "bus", region ap-northeast-1). The "BD external bot" itself runs on **EKS**, not EC2. These Node bots co-locate on the crawler box because it's already an outbound/egress environment.
- The EC2 crawler's own **18:00-vs-20:00-UTC manifest-timing bug is out of scope** — a separate issue, left untouched.
- SignalDesk's `marketBaseUrl` setting is still the placeholder `yourplatform.com/markets` — harmless in link mode (pure_news strips URLs); fix if you enable News+Odds mode.

## Quick verify (local)
- Blofin: `npm ci && npm run build && npm test` → 17 tests.
- SignalDesk (on `legal-redline-shim`): `npm install && npm run build && npm test` → 97 tests.
