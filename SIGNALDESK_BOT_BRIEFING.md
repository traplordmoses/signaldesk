# SignalDesk Bot Briefing

## Reference Documents

- Pre-deployment audit (`signaldesk-review.md`): `TODO: add link`
- Phase 2 upgrade proposal (live Polymarket/Kalshi data integration): `UPGRADE_PROPOSAL.md` in repo root
- Vitest regression suite: `src/app/api/lark/callback/route.test.ts`

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
6. Reviewers approve, reject, or edit drafts inline directly inside the Lark card (no DM round-trip).
7. Approved posts generate a private Lark message with a pre-filled X/Twitter posting link.
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

- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_REVIEW_CHAT_ID`
- `LARK_VERIFICATION_TOKEN` — Schema 2.0 callbacks (card buttons) carry this token in the request body's `header.token` instead of using HMAC headers. Without it set, the server returns 500 on every card click.

Optional Lark environment variable:

- `LARK_ENCRYPTION_KEY` — only required if "Encryption Strategy" is enabled in the Lark dev console. When set, the server decrypts inbound bodies (AES-256-CBC) before verification.

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

Do not commit `.env.local` or production secrets to Git.
