# Newsroom upgrade

## Active without new credentials

RSS items are saved as each source completes and immediately offered to the pipeline. Selected official feeds poll every minute, all other sources every five minutes. Selection runs at least every 30 seconds. Routine drafts use the configured cooldown precisely; urgent drafts can bypass it, subject to three per hour, one-minute spacing, the daily cap, and a 10% daily reserve. Urgent eligibility requires a known recent source timestamp, a material development, and either a primary source or a trusted source with a Probly match. These are generation targets, not publication guarantees.

Drafts use the canonical source headline and available feed summary, deterministic number/qualifier checks, and a separate model evidence check. Exact supporting excerpts and the verified content hash are saved. Verification does not establish the source's independent truth, and this release does not fetch full articles behind feeds. Unknown timestamps receive UPDATE. Old sources and stale alert labels block approval. Edited drafts require another verification and lose prior legal clearance. Sensitive drafts require an explicit legal-clearance attestation.

Market matching checks fixture date, participants, competition and market type. Totals/spreads and mismatched future fixtures abstain. A single-team injury or lineup story may have a contextual match; it is labeled related. Entity synonyms are grouped rather than counted as independent evidence. Public scraped market data older than two hours cannot be matched. Scraped prices are never used for market replies.

Generation leases and a persistent delivery outbox recover interrupted work. Lark sends use stable deduplication UUIDs. Failed delivery retries independently of generation, with eight attempts and bounded exponential backoff. An explicit pause preserves queued jobs. Drafts still need human review and manual publication.

## Review workflow

1. Review the source, evidence and market-fit reason in Lark or `/review`.
2. Edit or refresh stale labels in the dashboard; the draft is verified again.
3. For sensitive stories, record legal clearance, then approve. `LEGAL_REVIEWER_IDS` can limit attestation to named Lark open IDs; without it this is an authenticated reviewer attestation, not verified legal identity. The shared web dashboard records actor `web`.
4. Opening X changes the dashboard status to Publishing. Paste the actual X status URL afterward to confirm publication. The system records reviewer confirmation, not an X API verification.
5. Reject with a specific reason; expiration remains distinct from rejection.

Existing drafts without a verified evidence hash require Refresh & verify. Drafts older than four source-hours require a new development. Existing approvals are not retroactively asserted to be verified. Old Lark buttons can point to the dashboard to refresh a draft.

`/api/newsroom` exposes authenticated outcomes, latency, rejection reasons, source errors, generation/delivery states and worker heartbeats. `/api/health` exposes only aggregate health. Use actual publication counts and approval time to judge throughput; draft count alone is not success.

## Optional Probly feed

Set `PROBLY_MARKET_FEED_URL` and, if required, `PROBLY_MARKET_FEED_TOKEN`. Polling is every 30 seconds. Return JSON:

```json
{"markets":[{"slug":"unique-market-id","eventSlug":"canonical-event-slug","question":"Will Arsenal win against Chelsea?","category":"sports","league":"Premier League","priceYes":0.51,"bid":0.50,"ask":0.52,"liquidity":12000,"observedAt":1790000000000,"endMs":1790100000000}]}
```

Times are Unix milliseconds, prices are 0–1, liquidity is in the feed's documented common currency. The feed must be a complete current directory, not a delta. Every quote must be at most 60 seconds old. IDs must be unique and URL-safe. The event slug must resolve on Probly. An invalid or stale batch is rejected without replacing the previous directory. No public API endpoint is assumed.

A movement candidate requires two consecutive quotes at least five percentage points from the same 15-minute baseline, two minutes of history, liquidity at least 10,000 and spread at most 0.05. Alerts are debounced per market for 30 minutes. They describe market prices, not confirmation of the underlying event. They pass normal editorial selection and verification; no separate automatic publication occurs.

A separately reviewed market reply requires a direct match and a feed quote under 60 seconds old, liquidity at least 1,000 and spread at most 0.05. It includes a quote timestamp and canonical market URL. Confirm the main X post URL before opening the reply intent. Quotes expire while awaiting review and must be prepared again. With only the public scraper, this feature deliberately reports that no fresh quote is available.

## Optional X ingestion

Set `X_BEARER_TOKEN` and comma-separated numeric `X_NEWS_AUTHOR_IDS`. Provision appropriate filtered-stream rules in the existing X account first. The adapter never modifies rules or purchases API access. It accepts original posts only from allowlisted accounts, records their source time, and reconnects with backoff. Source selection is editorial responsibility: use primary organizations and reporters with suitable verification practices. Account handles and display names alone are not identity checks. Without both variables, this adapter is off.

## Deployment and rollback

Use Node 22 and the committed lockfile. Run `npm test`, `npx tsc --noEmit`, and `SIGNALDESK_DISABLE_SCHEDULER=1 DB_PATH=/tmp/signaldesk-build.db npm run build -- --webpack`. The scheduler must be disabled during build, and the build database must not be production. Standalone output requires copies of `.next/static` and `public` inside `.next/standalone`.

Build in a separate release directory while the old service runs. Validate it against an isolated database with the scheduler disabled. Before cutover, keep an on-server SQLite backup, the old commit, and the old `.next` directory. Additive migrations run on startup and preserve editorial history. Switch the code/build together and restart `signaldesk`; inspect health and worker heartbeats. Rollback code/build together; added columns and tables are backward-compatible. Do not restore the database unless corruption actually requires it, because that would lose subsequent reviews.

No queue backfill beyond recent undelivered pending drafts is performed. No paid integrations or new feed credentials are enabled by deployment.
