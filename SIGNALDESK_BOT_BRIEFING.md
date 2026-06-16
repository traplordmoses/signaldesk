# SignalDesk Bot Briefing

> **Update — link mode (outbound-only).** This briefing predates the link-mode
> conversion. The Lark review card no longer has Approve/Reject/Edit/Pause
> callback buttons — each draft now carries a plain **"Post on X"** link (X
> intent composer). The bot receives no Lark callbacks and runs no inbound
> webhook; full approve/reject/edit management lives in the dashboard. See
> `README.md` for the current flow.

## Reference Documents

- Pre-deployment audit (`signaldesk-review.md`): `TODO: add link`
- Phase 2 upgrade proposal (live Polymarket/Kalshi data integration): `UPGRADE_PROPOSAL.md` in repo root
- Vitest regression suites: `src/lib/news/scorer.test.ts` (the Lark callback route and its test were removed in link mode)
- Production deploy script: `scripts/deploy.sh`
- One-time DB-path migration script: `scripts/migrate-db-path.sh`

## Project Background

Social media content for prediction markets is highly news-driven. SignalDesk was built to continuously scan event-based news across multiple categories and generate candidate social posts from relevant news.

Example post types include:

- Breaking news
- Just in updates
- Brief analysis of news events and market impact
- Posts that include market probability context and market links

SignalDesk Bot automates news ingestion, filtering, scoring, post generation, and Lark review routing. The goal is to improve content production efficiency while keeping final editorial approval in human hands.

## Completed Deployment Summary

The technical review and deployment work is complete for the launch-phase version of SignalDesk.

What was completed:

- Reviewed the inherited codebase and documented pre-deployment risks.
- Fixed the launch-blocking security and reliability issues found during the audit.
- Removed hardcoded Lark credentials from the codebase.
- Re-enabled build-time safety checks.
- Verified the app locally with tests and a production build.
- Deployed the application to a DigitalOcean VPS.
- Configured the app to run as a persistent production service.
- Put Nginx in front of the app as a reverse proxy.
- Enabled HTTPS with a Let's Encrypt certificate.
- Protected the dashboard and internal API routes with authentication.
- Left the Lark callback and health-check routes publicly reachable.
- Verified the deployed health endpoint, dashboard access, API protection, and Lark callback challenge handling.
- Configured the production Lark review chat ID.
- Verified the production server can send messages to the configured Lark group.
- Verified the production server can send SignalDesk review cards to the configured Lark group.

## Current Production Status

SignalDesk is no longer dependent on a local computer. It now runs as a production service on a DigitalOcean VPS.

- Public app URL: `https://67-205-179-227.sslip.io`
- Lark callback URL: `https://67-205-179-227.sslip.io/api/lark/callback`
- Dashboard URL: `https://67-205-179-227.sslip.io/review`

The production stack is:

- Next.js 16 application
- SQLite via `better-sqlite3`
- Persistent database file on the server
- Next standalone production build
- `systemd` service for process management
- Nginx reverse proxy
- HTTPS via Let's Encrypt
- Basic Auth on dashboard and protected API routes
- Public access only for `/api/health` and `/api/lark/callback`

The old local deployment approach using `pm2` and `npm run dev` has been replaced by a production `systemd` service running the Next standalone build.

## How The Bot Works Now

The production workflow is:

1. News-source ingestion runs every 5 minutes across RSS feeds and selected official API-backed feeds.
2. New articles are deduplicated, filtered, scored, and clustered into events.
3. Candidate post generation runs every 15 minutes for qualifying clusters.
4. Generated posts are stored in SQLite.
5. If Lark is enabled and configured, generated posts are sent to the configured Lark review group.
6. The Lark card opens read-only by default — `[✅ Approve] [❌ Reject]` are the primary actions, with a separate `[✏️ Edit]` button as a secondary affordance. Clicking Edit patches the card in place to reveal an inline textbox plus `[💾 Save edit]` / `[↩️ Cancel]`. No always-on form, no DM round-trip required for edits.
7. Approving the post sends the reviewer a private DM from the bot containing the tweet text and an "Open X to post" button — the button opens X with the tweet pre-filled, the human still clicks Post on X to publish. There is no API auto-posting.
8. Final publishing to X remains manual for the launch phase.

There is no direct X API publishing in the current production version. The workflow intentionally keeps the final posting step manual.

## Lark Integration Status

The Lark server-side integration is implemented, deployed, and connected to the review group. The app can receive Lark callbacks at the production callback URL, validate signed callbacks, process review actions, and send messages to the configured group chat.

Completed Lark setup:

- Lark app permissions configured.
- Bot added to the review group chat.
- Review group chat ID discovered.
- `LARK_REVIEW_CHAT_ID` set on the production server.
- Production Lark text-message send test passed.
- Production Lark review-card send test passed.
- Production callback URL verification test passed.

Required Lark permissions:

- `im:message`
- `im:message:send_as_bot`
- `im:message:update`
- `im:chat:readonly`

Required server environment variables:

- `ANTHROPIC_API_KEY`
- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_REVIEW_CHAT_ID`
- `LARK_VERIFICATION_TOKEN` — Schema 2.0 callbacks (card buttons) carry this token in the request body's `header.token` instead of using HMAC headers. Without it set, the server returns 500 on every card click.
- `BOT_API_TOKEN` — bearer for protected `/api/*` routes (everything except `/api/health` and `/api/lark/callback`).
- `DB_PATH` — absolute path to the SQLite file, set to a location OUTSIDE the project tree (e.g. `/var/lib/signaldesk/signaldesk.db`) so `next build` can never trace it as a runtime asset and clobber it. See "April 29 Hardening Sprint" below for context. Falls back to `./data/signaldesk.db` for local dev.

Optional environment variables:

- `LARK_ENCRYPTION_KEY` — required only if "Encryption Strategy" is enabled in the Lark dev console. When set, the server decrypts inbound bodies (AES-256-CBC) before verification.
- `ANTHROPIC_MODEL` — override the default `claude-haiku-4-5-20251001`.
- `SIGNALDESK_USER_AGENT` — sent as the User-Agent for stricter feeds (SEC EDGAR, weather.gov). Use a real contact address in production, e.g. `SignalDeskBot/1.0 (ops@example.com)`.
- `OPENFDA_API_KEY` — increases rate limits for openFDA recall feeds.
- `RUN_MIGRATIONS=1` — explicitly opt in to running pending Drizzle migrations on startup (skipped by default in production).

The callback URL should be configured in Lark as:

```text
https://67-205-179-227.sslip.io/api/lark/callback
```

Lark callback encryption is supported in production. When "Encryption Strategy" is enabled in the Lark dev console, the server decrypts inbound bodies using `LARK_ENCRYPTION_KEY` (AES-256-CBC, key = SHA-256 of the encryption-key string from the dev console). Both modes — encryption on or off — work without code changes.

## Adding the Bot to a New Group Chat

**For team members who want SignalDesk to post into another group**: you don't have to do any configuration yourself. Just message the operator and they will set it up. The rest of this section is for the operator.

The bot has the `im:message:send_as_bot` scope, so it can post in any group it has been added to. Pointing review traffic at a different group is a 4-step process:

1. **Invite the bot to the new group via the Lark UI.**
   - Open the target group chat.
   - Group settings → Add Members → search `Signaldesk Bot` → Add.
   - This is the only step that has to happen inside Lark.

2. **Discover the new group's chat ID.**
   - Lark addresses groups internally by an `oc_<hex>` chat ID, not by display name.
   - From the production server, call the Lark `chat/list` API with the deployed app credentials and copy the new group's `chat_id`.
   - The repo includes a one-shot diagnostic script for this — see the `scripts/` directory.

3. **Update the production environment variable.**
   - Edit `/etc/signaldesk.env` and set `LARK_REVIEW_CHAT_ID=oc_<new id>`.
   - One review group at a time. The current production code reads a single value; routing reviews to multiple groups concurrently is not implemented.

4. **Restart the service and verify.**
   - `systemctl restart signaldesk`
   - `systemctl status signaldesk`
   - `journalctl -u signaldesk -f`
   - Optionally fire a test review-card send to confirm the bot can post into the new group.

Notes:

- If the bot is kicked from a group, re-adding it works the same way. No credential regeneration is needed unless the underlying Lark app was rotated.
- If the Lark app itself is rotated or replaced (new app ID/secret), all the related env vars (`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`, and `LARK_ENCRYPTION_KEY` if encryption is on) must be updated together. The callback URL also has to be re-verified in the Lark dev console.
- The bot continues to work normally for the existing group during the swap — there is no downtime beyond the systemd restart.

## LLM Integration

The current code path uses Anthropic/Claude through:

- `ANTHROPIC_API_KEY`
- optional `ANTHROPIC_MODEL`

The default model in code is Claude Haiku. Older references to Together AI are outdated for this deployment unless a separate branch or environment still uses Together.

Future work may still include replacing Anthropic with a company-managed model provider.

## Operational Configurability

Operational controls are available through the dashboard/settings UI:

- Auto-generation score threshold
- Daily post limit
- Post cooldown
- Lark notification toggle
- News source enable/disable
- News source weights

Additional configurability can be added later if operations needs more control:

- Prompt editing
- Post type controls
- Platform-specific formatting rules
- Market link and probability chart behavior
- Additional review routing rules

## Launch Phase Operating Model

For the 4/28 launch phase, the goal is not full public-scale automation. The practical goal is to support a lightweight social content rhythm with server-side automation and human approval.

Launch-phase goals:

- Maintain account presence
- Build up content inventory
- Establish a basic information output cadence
- Support manual content planning around key events of the week

The launch-phase workflow is:

1. SignalDesk ingests news, filters signals, and generates candidate posts.
2. The team reviews posts in Lark or the dashboard.
3. Approved posts are manually published to X using the pre-filled posting link or copy/paste.

This is not a fully automated publishing workflow by design. It keeps editorial control with the team while removing most of the manual news monitoring and first-draft writing work.

## Post-Launch Follow-Ups

Recommended follow-up items:

1. Replace the temporary `sslip.io` URL with a real domain if desired.
2. Set up regular SQLite backups.
3. Decide whether to keep manual X posting or build direct X API publishing.
4. Decide whether to keep Claude/Anthropic or move to a company-managed model provider.
5. Add stronger monitoring and alerting for cron failures and Lark send failures.

## Security And Reliability Hardening Already Completed

Several launch-blocking issues were fixed before deployment:

- Lark callback signature verification fails closed when the app secret is missing.
- Lark callbacks require signature headers, timestamp freshness, and nonce replay protection.
- Protected API routes require a server-only bearer token.
- Health and Lark callback routes are explicitly whitelisted.
- Prompt-injection patterns are sanitized before generation.
- AI responses are schema-validated.
- Banned phrases and fabricated percentage checks are enforced.
- High-risk clusters are auto-skipped.
- Daily generation cap is enforced.
- RSS deduplication and scoring were hardened.
- Hot-path SQLite indexes were added.
- Cron overlap guards were added.
- Audit log and processed news pruning were added.
- Production migrations are gated behind `RUN_MIGRATIONS=1`.
- Build-time type checking is enabled.
- Empty catch blocks now log errors.

## Detailed Changelog

The "Security And Reliability Hardening Already Completed" section above lists the launch-blocker fixes from the pre-deployment audit. This section covers the rest of the production work and the post-launch updates.

### Pre-Deployment Hardening (audit-driven)

Triggered by the critical review documented in `signaldesk-review.md`. Sixteen launch-blocking issues were resolved. Highlights:

- Removed hardcoded Lark credentials and re-enabled build-time type checking.
- Closed the URL-verification challenge bypass — only payloads with `type: 'url_verification'` echo the challenge.
- Made signature verification fail closed when `LARK_APP_SECRET` is unset.
- Added timestamp freshness (±5 min) and in-memory nonce replay protection on the legacy callback path.
- Sanitized prompt-injection patterns before LLM generation.
- Schema-validated Anthropic responses.
- Enforced banned phrases and fabricated-percentage checks on generated drafts.
- Auto-skipped HIGH-RISK clusters and enforced the daily generation cap.
- Hardened RSS deduplication (title hash, URL normalization) and added hot-path SQLite indexes.
- Added per-task cron overlap guards.
- Added daily prune of audit log and processed-news rows.
- Gated production migrations behind `RUN_MIGRATIONS=1`.
- Empty catch blocks now log errors instead of silently swallowing them.

### Production Deployment

Moved off the local Mac and onto a managed server.

- Provisioned a DigitalOcean droplet (1 vCPU, 1 GB RAM, 35 GB disk) at `67.205.179.227`.
- Built and deployed the Next.js standalone production build to `/var/www/signaldesk`.
- Wrote a `systemd` service (`signaldesk`) to run the build under a service account with auto-restart.
- Installed Nginx as a reverse proxy in front of the Next server on `127.0.0.1`.
- Issued a Let's Encrypt certificate via certbot for the sslip.io hostname (`67-205-179-227.sslip.io`).
- Added Basic Auth in front of the dashboard (`/review`) and protected internal API routes behind a `BOT_API_TOKEN` bearer.
- Whitelisted `/api/health` (monitoring probes) and `/api/lark/callback` (signature-verified) as the only publicly reachable endpoints.
- Configured `LARK_REVIEW_CHAT_ID` for the production review group on the live server.

### Lark Schema 2.0 Card Migration

Replaced the legacy interactive-card format with Schema 2.0 across the message helpers in `src/lib/lark/messages.ts`.

- All review and DM cards now use `schema: '2.0'`, `body.elements`, and `behaviors: [{ type: 'callback', value }]` for buttons.
- Helper functions (`md`, `plainText`, `callbackButton`, `urlButton`, `twoColumnButtons`) keep card construction terse and consistent.
- Schema 2.0 cards render correctly on both Lark mobile and Lark desktop, where the Schema 1.0 cards had inconsistent button rendering on certain clients.

### Inline Edit (no DM round-trip)

The previous edit flow asked the reviewer to DM the bot with the edited text. That flow has been replaced.

- Review cards now embed an `<input>` form element for inline editing inside the card itself.
- Card form values are surfaced via `action.form_value.edited_content` on the card-action callback.
- The route normalizer resolves the inline form value into `action.value.editedContent` so downstream handlers don't have to special-case it.
- The `im.message.receive_v1` DM-receive path is now a deliberate no-op — the subscription can be removed in the Lark dev console at any time.

### Dual-Auth Callback Path

Lark uses two different callback authentication schemes depending on the event type, and the inherited code only handled one of them.

- Legacy path (Schema 1.0 / `*_v1` events): retains `x-lark-signature` + `x-lark-request-timestamp` + `x-lark-request-nonce` HMAC verification.
- Schema 2.0 path (`card.action.trigger`, `im.message.receive_v1`): no headers are sent. The server now verifies `header.token` against `LARK_VERIFICATION_TOKEN`, checks `header.create_time` (microseconds) for ±5 min freshness, and uses `header.event_id` for replay protection.
- Detection is automatic: presence of `schema: '2.0'` or `header.token` routes the request to the Schema 2.0 verifier.
- Both paths fail closed when their respective secret/token is unset (500), to avoid an attacker triggering the unauthenticated branch by removing the env var.

### Encrypted Callback Body Support

When "Encryption Strategy" is enabled in the Lark dev console, every inbound callback (including the URL-verification challenge) arrives as `{ "encrypt": "<base64>" }`.

- Added an outer-layer decryption step before any other parsing.
- Format: 16-byte IV + AES-256-CBC ciphertext, key = SHA-256 of the encryption-key string from the dev console.
- Decryption failure returns 401 (avoids leaking whether the body would otherwise be accepted).
- A missing `LARK_ENCRYPTION_KEY` while an encrypted body arrives returns 500 — the server fails closed rather than guessing or accepting an unencrypted fallback.
- Verified live in production: encrypted callback → decrypt → Schema 2.0 token verify → handler dispatch, all observed in `journalctl` on a live button click.

### Vitest Regression Suite

Added `src/app/api/lark/callback/route.test.ts` to lock the auth contract.

- Each test maps to a specific bypass that the inherited code allowed.
- Coverage spans: URL-verification challenge gating, missing-secret fail-closed behavior, missing/invalid signature headers, stale timestamps, replay nonces, Schema 2.0 token mismatches, stale `create_time`, encrypted-body decryption, decryption-key mismatch, the inline-edit form path, and the no-op behavior on `im.message.receive_v1`.
- The handler is mocked so the tests stay focused on the auth boundary, not on downstream business logic.

### Live Production Verification

Each milestone was verified end-to-end on the live server, not just locally.

- Health endpoint reachable over HTTPS.
- Dashboard returns 401 without Basic Auth, 200 with.
- Internal API routes return 401 without bearer, 200 with.
- Lark URL-verification challenge: success.
- Production text-message send: success.
- Production review-card send: success.
- Live button click on a Schema 2.0 review card with encryption enabled: callback received, decrypted, token-verified, handler dispatched, post status updated, X-posting DM sent — all observed in production logs.

### Configuration Discovery Note

During the encryption rollout, the verification token initially provided was incorrect (Lark's dev console has multiple credential fields and the wrong one was copied). The empirically-correct token was captured from a live callback's `header.token` and pinned in `/etc/signaldesk.env`. Worth flagging as a caution for future credential changes: trust what Lark actually sends, not just what the dev console UI labels suggest.

### April 29 Hardening Sprint

A second day-long pass that turned the bot from "running but fragile" into "boring to operate". Bundled into a few coherent commits.

#### Lark callback delivery (the morning's silent-failure mystery)

Card-button clicks weren't reaching the server. Symptoms: cards visibly delivered, reviewers clicking buttons, zero callbacks in the Nginx access log for hours. Root causes, in order:

1. **Multi-post card name collision.** When a cluster generated 2+ posts (the old high-priority dual-mode emit), the card included one form per post, each with an `<input name="edited_content">`. Lark requires globally unique input names across the entire card and rejects with API error 11310: `name(edited_content) duplicate`. Fix: scope input names per post (`edited_content_<postId>`) and update the route's `extractFormString` to look up by the post id from `action.value`. Regression test added.
2. **Encryption key rotation drift.** The Lark dev console's encryption key got rotated mid-day, but the server's `LARK_ENCRYPTION_KEY` env var was stale. Outcome: every encrypted callback failed decryption with 401, Lark eventually stopped retrying (5+ hours of silence). Fix: re-sync the key from the dev console; the server-side decrypt logic was already correct.

#### Auto-generation locked to `pure_news`

The 15-min generation cron now always emits a single `pure_news` post per cluster. Previously, high-scoring clusters could emit two posts including AI-mode-pick, which intermittently produced `news_odds` ("what does this mean for the market?") or `engagement` (3-5 sentence analysis) drafts that drifted from the team's BREAKING/JUST IN voice. The other modes remain available via the manual `POST /api/posts/generate` endpoint with an explicit `mode` override.

The `pure_news` prompt itself was also tightened with the team's preferred examples as gold standards, an explicit two-sentence shape rule (second sentence adds context, not just another fact), and an allowance to use `JUST IN:` as well as `BREAKING:` as a prefix.

#### Pre-LLM headline filter

Added `src/lib/ai/headline-filter.ts` with a small list of low-signal headline patterns (opinion pieces, weekly recaps, podcasts, listicles, explainers). The auto-generate cron now runs this filter on cluster headlines BEFORE spending an Anthropic call. Skipped clusters get `status='low_signal_skipped'` so they don't re-qualify on the next 15-min tick.

#### Risk gate split: TRAGEDY vs HIGH_STAKES

The previous HIGH_RISK gate auto-skipped on a single keyword hit, including legitimate prediction-market-relevant breaking news (`nuclear`, `criminal`, `doj`, `indicted`, `sec charges`). The "King Charles agrees with Trump on Iran nuclear weapon ban" cluster was simultaneously boosted to score 5.5+ by TIER1 (which also contains `nuclear`) AND blocked from generation by the same word. Self-defeating.

Split the gate into two tiers:

- **TRAGEDY (auto-skip)** — narrow, unambiguous: `killed, casualties, victims, fatalities, shooting, bombing, terror, terrorist, hostage, massacre`. The bot must NEVER auto-write competing content during an active tragedy.
- **HIGH_STAKES (warn-only, generate)** — legal/DOJ/financial enforcement, geopolitical escalation, election heat, political controversy. The card already shows a yellow ⚠️ Medium-risk warning; that's the correct surface for "look twice before approving".

Locked in by `src/lib/news/scorer.test.ts` — 21 cases covering tragedy headlines, high-stakes headlines, routine headlines, priority ordering when both tiers match, and word-boundary substring guards.

#### Source coverage expansion: 27 → 69 active sources

Two parallel workstreams landed together.

The standard-RSS additions (~30 sources) filled gaps the bot was thin on:
- International: SCMP, Times of India, Nikkei Asia, Euronews, CBC, Time, NPR Politics, Bloomberg Markets
- US government primary: White House Presidential Actions, Congress.gov Most-Viewed Bills
- Defense: Breaking Defense
- Cyber blogs: Krebs on Security, BleepingComputer, The Hacker News, 404 Media
- Biotech / pharma: STAT News
- Sports beyond ESPN: The Athletic, Sky Sports News
- Science / space: BBC Science & Environment, SpaceNews
- Entertainment: Variety, Hollywood Reporter, Deadline, TMZ, Page Six, BBC Entertainment & Arts
- Music: Billboard
- Gaming: GameSpot
- Energy: Utility Dive
- Wire fallback: AP via feedx mirror (more reliable than the Google News RSS workaround)

Eight previously-broken sources also got their URLs repaired (AP, Reuters, Politico, Axios Markets all moved or got blocked) and the dead Reuters feeds got pointed at Google News RSS site:filter mirrors as a workaround for Reuters killing public feeds in 2022.

A new `signaldesk://` custom protocol was introduced for primary-data sources that aren't standard RSS. Handlers in `src/lib/news/fetcher.ts` translate these to direct API calls:

- `signaldesk://sec/current?type=8-K&count=100` — SEC EDGAR current 8-K filings
- `signaldesk://cisa/kev` — CISA Known Exploited Vulnerabilities catalog
- `signaldesk://nws/severe-alerts` — National Weather Service severe alerts
- `signaldesk://usgs/significant-quakes` — USGS significant earthquakes
- `signaldesk://openfda/enforcement?kind=drug|device|food` — openFDA recall enforcement actions

Plus standard RSS for the Federal Reserve press / monetary / speeches / testimony feeds and PR Newswire.

#### Scorer keyword expansion for the new content shapes

`src/lib/news/scorer.ts` got new keywords across both scoring tiers:

- TIER1 (+4 score): `tornado warning`, `hurricane warning`, `major earthquake`, `KEV catalog`, `emergency alert`, `FOMC statement`
- TIER2 (+2 score): `CVE`, `vulnerability`, `exploit`, `data breach`, `cyberattack`, `class I recall`, `class II recall`, `material definitive agreement`, `regulation FD disclosure`, `severe thunderstorm warning`, `flash flood warning`, `earthquake`, `recall`, `guidance`, `results of operations`
- HIGH_STAKES (warn): `data breach`, `cyberattack`, `KEV catalog`, `class I recall`

#### Card UX redesign: read-only by default

The original review card always rendered the inline edit textbox below the tweet quote, which made every card look like a form the reviewer had to fill out — even when the common path is just "read tweet, click Approve". Refactor:

- **Read-only mode (default):** quote, then `[✅ Approve] [❌ Reject]` side by side, then a separate `[✏️ Edit]` button on its own row.
- **Edit mode:** clicking Edit patches the card in place via `larkPatch` to reveal the textbox, `[💾 Save edit]`, `[↩️ Cancel edit]`, plus the same Approve / Reject so a reviewer can change their mind without saving.
- Cancel reverts the card to read-only with no DB writes; Save updates the post content and re-renders the card.

Also renamed `Approve & Copy` → `Approve` everywhere — "Copy" was a misnomer since the approval flow doesn't touch the clipboard, it DMs the reviewer with the X intent-link button.

#### Decision: keep human-in-loop X posting (no API auto-post)

Considered wiring up the X API to publish approved drafts automatically. Decided against it for the launch phase. The current "Approve → DM with intent-link → human clicks Post on X" flow has three properties auto-posting can't match:

1. **Final-step human review.** The X composer step is itself an editing surface — operators can tweak in the composer right before posting.
2. **No recurring API cost.** As of Feb 2026, X eliminated the free tier for new developer apps and moved to pay-per-use; auto-posting would add a recurring bill for capability the bot doesn't actually need.
3. **Blast-radius isolation.** A bug or hallucination can't push a tweet live without a human seeing it first.

The publisher abstraction was scaffolded out (shared module, status-state-machine, env flag, dashboard wiring) and then deliberately not enabled. If we change our minds, the integration drops in behind a single `X_PUBLISH_ENABLED=true` flip.

#### Database externalized to `/var/lib/signaldesk/`

Earlier in the day, a `next build` clobbered the live SQLite DB. Root cause: `output: 'standalone'` in `next.config.ts` traces all cwd-relative file paths as runtime assets. Since `src/lib/db/index.ts` resolved the DB path with `path.join(process.cwd(), 'data', 'signaldesk.db')`, the build copied the project-root `data/` directory into `.next/standalone/data/` — overwriting whatever was live. Lost ~6 hours of news state and one already-sent post.

Fix: `src/lib/db/index.ts` now honors a `DB_PATH` env var, falling back to the cwd-relative path only for local dev. Production points at `/var/lib/signaldesk/signaldesk.db` — outside the project tree, so the build can no longer see or copy it. `scripts/migrate-db-path.sh` handles the one-time move (stop service → checkpoint WAL → mv DB + sidecars → update `/etc/signaldesk.env` → start service).

#### Graceful SIGTERM handler

A separate root cause for data loss across deploys: `systemctl stop signaldesk` sent SIGTERM, the Node process never exited cleanly, systemd waited 90s and SIGKILL'd. SIGKILL leaves the SQLite WAL un-checkpointed, so any cp of the main DB file misses the latest writes — which is how a generated post got lost during one earlier deploy.

Fix in `src/lib/cron/scheduler.ts`: on SIGTERM/SIGINT, the bot stops registered cron tasks, runs `PRAGMA wal_checkpoint(TRUNCATE)`, closes the sqlite handle, then `process.exit(0)`. Restarts now complete in under 5 seconds instead of 90+.

#### Reusable deploy script

`scripts/deploy.sh` is now the canonical post-DB_PATH deploy path:

```bash
ssh root@67.205.179.227
cd /var/www/signaldesk
./scripts/deploy.sh           # full: pull + build + restart
./scripts/deploy.sh --skip-pull   # rebuild current checkout
```

Stop is graceful, the script runs a defensive `PRAGMA wal_checkpoint(TRUNCATE)` against the live DB before any builds, copies static assets back into the standalone tree (Next 16 doesn't include `.next/static` in the standalone output), and verifies the service comes back active before exiting.

#### Net result

| | Before April 29 | After April 29 |
|---|---|---|
| Active news sources | 27 | 69 (+11 custom-protocol primary-data feeds, +30 standard RSS) |
| Source error rate per fetch | 8 / 27 = 30% | 2-3 / 69 = ~4% |
| Lark card UX | Always-visible textbox | Read-only with opt-in edit |
| Multi-post Lark sends | Broken (API 11310) | Working, regression-tested |
| Risk gate | Single-keyword auto-skip | Two-tier (tragedy → skip; high-stakes → warn) |
| Auto-gen mode | 1-2 posts, mixed modes | Single `pure_news` per cluster |
| Pre-LLM filter | None | `isWorthyHeadline()` |
| Generation prompt | Generic news voice | Team's preferred examples as gold standards |
| DB clobber risk on deploy | Yes | No (DB_PATH externalized) |
| Service restart time | 90s+ (SIGKILL) | <5s (graceful checkpoint) |
| Deploy procedure | Hand-rolled SSH commands | `scripts/deploy.sh` |
| Test count | 17 | 39 (callback auth + scorer risk gate) |

## Deployment Notes

Production should be managed through the server process, not local development commands.

Current production shape:

- App directory on server: `/var/www/signaldesk`
- Server environment file: `/etc/signaldesk.env`
- Service manager: `systemd`
- Service name: `signaldesk`
- Reverse proxy: Nginx
- HTTPS certificate: Let's Encrypt

Typical operational commands on the server:

```bash
systemctl status signaldesk
systemctl restart signaldesk
journalctl -u signaldesk -f
nginx -t
systemctl reload nginx
```

Standard deploy from the server (run as root):

```bash
cd /var/www/signaldesk
./scripts/deploy.sh
```

That script handles: graceful stop → defensive WAL checkpoint → `git pull` → `npm run build` → copy static assets into the standalone tree → `systemctl start` → service-active verification. Skip the pull with `./scripts/deploy.sh --skip-pull` to rebuild the current checkout.

Do not commit `.env.local` or production secrets to Git. The `.env.example` template is checked in (whitelisted in `.gitignore`) and lists every env var the bot looks at.

Production paths:

- App directory: `/var/www/signaldesk`
- Live SQLite DB: `/var/lib/signaldesk/signaldesk.db` (outside the project tree on purpose)
- Server environment file: `/etc/signaldesk.env`
- systemd unit: `/etc/systemd/system/signaldesk.service`
- Nginx config: `/etc/nginx/sites-enabled/signaldesk`
