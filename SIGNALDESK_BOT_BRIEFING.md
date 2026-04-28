# SignalDesk Bot Briefing

## Reference Documents

- Pre-deployment audit: `TODO: add link`
- Fixes / remediation notes: `TODO: add link`

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

1. RSS ingestion runs every 5 minutes.
2. New articles are deduplicated, filtered, scored, and clustered into events.
3. Candidate post generation runs every 15 minutes for qualifying clusters.
4. Generated posts are stored in SQLite.
5. If Lark is enabled and configured, generated posts are sent to the configured Lark review group.
6. Reviewers can approve, reject, or request edits from Lark.
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

The callback URL should be configured in Lark as:

```text
https://67-205-179-227.sslip.io/api/lark/callback
```

Lark callback encryption should remain disabled unless the server code is updated to support encrypted callback payloads.

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
- RSS source enable/disable
- RSS source weights

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
