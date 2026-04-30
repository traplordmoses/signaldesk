import cron from 'node-cron'
import { db, sqlite } from '@/lib/db'
import { eventClusters, settings, generatedPosts } from '@/lib/db/schema'
import { eq, and, gt, isNull } from 'drizzle-orm'
import { isWorthyHeadline } from '@/lib/ai/headline-filter'

let started = false

// Per-task overlap guards. Without these, a slow run of `runFetch` would let the
// next 5-min tick stack on top of itself — eventually saturating Together AI / DB.
const running = { fetch: false, generate: false, prune: false, markets: false }

const AUDIT_LOG_RETENTION_DAYS  = 30
const NEWS_ITEM_RETENTION_DAYS  = 14   // only items already isProcessed=1
const PRICE_RETENTION_HOURS     = 24   // (forward-compat — not used yet)

async function runPrune() {
  if (running.prune) {
    console.warn('[cron] prune skipped — previous run still in progress')
    return
  }
  running.prune = true
  const startedAt = Date.now()
  try {
    const auditCutoff = Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const itemsCutoff = Date.now() - NEWS_ITEM_RETENTION_DAYS * 24 * 60 * 60 * 1000

    const audit = sqlite.prepare('DELETE FROM audit_log WHERE created_at < ?').run(auditCutoff)
    const items = sqlite.prepare('DELETE FROM news_items WHERE ingested_at < ? AND is_processed = 1').run(itemsCutoff)

    // VACUUM reclaims disk after large deletes. Cheap on a healthy SQLite.
    try { sqlite.exec('VACUUM') } catch (e) {
      console.error('[cron] VACUUM failed:', e)
    }

    console.log(`[cron] prune: -${audit.changes} audit, -${items.changes} news_items (${Date.now() - startedAt}ms)`)
  } catch (e) {
    console.error('[cron] prune failed:', e)
  } finally {
    running.prune = false
  }
}

async function runFetch() {
  if (running.fetch) {
    console.warn('[cron] fetch skipped — previous run still in progress')
    return
  }
  running.fetch = true
  const startedAt = Date.now()
  try {
    const { fetchAllSources } = await import('@/lib/news/fetcher')
    const { clusterNewItems } = await import('@/lib/news/clusterer')
    const { ingested, errors } = await fetchAllSources()
    const clustered = await clusterNewItems()
    const durMs = Date.now() - startedAt
    console.log(`[cron] fetch: +${ingested} articles, +${clustered} clusters, ${errors} errors (${durMs}ms)`)
    if (durMs > 4 * 60 * 1000) {
      console.warn(`[cron] fetch took ${durMs}ms — approaching the 5-min tick interval`)
    }
  } catch (e) {
    console.error('[cron] fetch failed:', e)
  } finally {
    running.fetch = false
  }
}

// Pending posts that haven't been approved/rejected after this many ms get
// flipped to status='expired' so they drop out of the dashboard's Pending
// Review count. 8h matches the natural decay of BREAKING/JUST IN framing —
// a card sitting unapproved past one work shift is almost certainly too
// stale to tweet as breaking news. The card stays in Lark chat (we don't
// patch it visually); the handler still accepts a manual approve/reject
// click on it if a reviewer decides it's still worth posting.
const PENDING_TTL_MS = 8 * 60 * 60 * 1000

function expireStalePendingPosts(): number {
  const cutoff = Date.now() - PENDING_TTL_MS
  const stale = db.select()
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.status, 'pending'),
        gt(generatedPosts.createdAt, 0),  // sanity bound
      )
    )
    .all()
    .filter(p => p.createdAt < cutoff)

  if (stale.length === 0) return 0

  const now = Date.now()
  for (const post of stale) {
    db.update(generatedPosts)
      .set({ status: 'expired', updatedAt: now })
      .where(eq(generatedPosts.id, post.id))
      .run()
  }
  console.log(`[cron] expired ${stale.length} pending post(s) older than ${PENDING_TTL_MS / 3600000}h`)
  return stale.length
}

async function runAutoGenerate() {
  if (running.generate) {
    console.warn('[cron] auto-generate skipped — previous run still in progress')
    return
  }
  running.generate = true
  const startedAt = Date.now()
  try {
    // Drain stale pending posts before generating new ones — keeps the
    // dashboard's Pending Review count tracking what's actually actionable.
    expireStalePendingPosts()

    const config = db.select().from(settings).where(eq(settings.id, 'singleton')).get()
    const threshold = config?.autoGenerateThreshold ?? 6.5
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000

    const rawCandidates = db.select()
      .from(eventClusters)
      .where(
        and(
          eq(eventClusters.status, 'new'),
          eq(eventClusters.postCount, 0),
          gt(eventClusters.firstSeenAt, sixHoursAgo)
        )
      )
      .all()
      .filter(c => (c.relevanceScore ?? 0) >= threshold)

    // Pre-LLM headline filter — drops opinion pieces, recaps, podcasts, etc.
    // before they cost an Anthropic call. Skipped clusters are marked
    // 'low_signal_skipped' so they don't re-qualify on the next tick.
    const candidates = []
    let skippedLowSignal = 0
    for (const c of rawCandidates) {
      if (isWorthyHeadline(c.canonicalHeadline)) {
        candidates.push(c)
      } else {
        skippedLowSignal++
        db.update(eventClusters)
          .set({ status: 'low_signal_skipped', lastUpdatedAt: Date.now() })
          .where(eq(eventClusters.id, c.id))
          .run()
      }
    }

    if (candidates.length === 0) {
      if (skippedLowSignal > 0) {
        console.log(`[cron] auto-generate: 0 candidates (${skippedLowSignal} skipped as low-signal)`)
      }
      return
    }

    // Highest-scored first, so when the per-cycle cap kicks in we always
    // generate the best stories. Tie-broken by recency (newer first).
    candidates.sort((a, b) => {
      const scoreDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
      if (scoreDiff !== 0) return scoreDiff
      return (b.firstSeenAt ?? 0) - (a.firstSeenAt ?? 0)
    })

    // Per-cycle cap. Without this, a backlog (e.g. just after the daily cap
    // resets) dumps every queued candidate into the chat in one tick — 12
    // cards at once. Cap at 5 per cycle: the rest stay status='new' and
    // qualify on the next tick (15 min later).
    const PER_CYCLE_CAP = 5
    const trimmed = candidates.slice(0, PER_CYCLE_CAP)
    const deferred = candidates.length - trimmed.length

    console.log(`[cron] auto-generate: ${candidates.length} candidates${skippedLowSignal ? ` (${skippedLowSignal} skipped as low-signal)` : ''}${deferred > 0 ? ` — generating top ${trimmed.length}, deferring ${deferred} to next cycle` : ''}`)

    const { generateSmartPosts } = await import('@/lib/ai/generator')

    for (const cluster of trimmed) {
      try {
        const posts = await generateSmartPosts(cluster)
        console.log(`[cron] generated ${posts.length} posts for: ${cluster.canonicalHeadline.slice(0, 50)}`)

        if (
          config?.larkEnabled === 1 &&
          process.env.LARK_APP_ID &&
          process.env.LARK_APP_SECRET &&
          process.env.LARK_REVIEW_CHAT_ID
        ) {
          try {
            const { sendClusterToLark } = await import('@/lib/lark/messages')
            // Only send posts that have NEVER been delivered to Lark. Without this
            // filter, any cluster that gets re-selected (status reverted, re-clustered,
            // generation failed previously, etc.) re-sends every post it ever produced
            // — that's how the Trump-approval card shipped 12 times in 5 hours.
            const unsent = db.select()
              .from(generatedPosts)
              .where(and(
                eq(generatedPosts.clusterId, cluster.id),
                isNull(generatedPosts.larkSentAt),
              ))
              .all()
            if (unsent.length === 0) {
              console.log(`[cron] no unsent posts for cluster ${cluster.id} — skipping send`)
            } else {
              const messageId = await sendClusterToLark(cluster, unsent)
              if (messageId) {
                for (const p of unsent) {
                  db.update(generatedPosts)
                    .set({ larkMessageId: messageId, larkSentAt: Date.now() })
                    .where(eq(generatedPosts.id, p.id))
                    .run()
                }
                console.log(`[cron] sent ${unsent.length} post(s) to Lark: ${cluster.canonicalHeadline.slice(0, 50)}`)
              } else {
                console.error(`[cron] Lark send returned no messageId for cluster ${cluster.id} — posts left unsent for retry`)
              }
            }
          } catch (larkErr) {
            console.error('[cron] Lark send failed:', larkErr)
          }
        }
      } catch (e) {
        console.error('[cron] generate failed for cluster', cluster.id, e)
      }
    }
  } catch (e) {
    console.error('[cron] auto-generate run failed:', e)
  } finally {
    const durMs = Date.now() - startedAt
    if (durMs > 10 * 60 * 1000) {
      console.warn(`[cron] auto-generate took ${durMs}ms — approaching the 15-min tick interval`)
    }
    running.generate = false
  }
}

// Refresh the prediction-market relevance signal — pulls top markets/events
// from Polymarket + Kalshi, runs LLM topic extraction on any new ones, and
// refreshes the cached entity → volume map used by `scoreItem` to apply a
// relevance boost. Runs hourly + once on startup. Failures are non-fatal:
// the scorer falls back to base scoring with no boost when the cache is empty.
async function runMarketsRefresh() {
  if (running.markets) {
    console.warn('[cron] markets refresh skipped — previous run still in progress')
    return
  }
  running.markets = true
  try {
    const { refreshMarketTopics } = await import('@/lib/markets')
    const r = await refreshMarketTopics()
    console.log(`[cron] markets refresh: poly=${r.polymarket} kalshi=${r.kalshi} new_extractions=${r.newExtractions}${r.errors.length ? ` errors=${r.errors.length}` : ''}`)
    if (r.errors.length > 0) {
      for (const err of r.errors.slice(0, 3)) console.warn(`[cron] markets:`, err)
    }
  } catch (e) {
    console.error('[cron] markets refresh failed:', (e as Error).message)
  } finally {
    running.markets = false
  }
}

// Tracks the registered cron tasks so the shutdown handler can stop them
// before closing the DB. Without this, an in-flight cron task could try to
// write to a closed sqlite handle.
const scheduledTasks: ReturnType<typeof cron.schedule>[] = []

let shutdownRegistered = false

function registerGracefulShutdown() {
  if (shutdownRegistered) return
  shutdownRegistered = true

  let shuttingDown = false
  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return  // ignore repeat signals during shutdown
    shuttingDown = true

    console.log(`[shutdown] received ${signal}, stopping cron + checkpointing DB`)

    // Stop scheduled cron tasks. Already-running task bodies finish naturally;
    // the per-task `running` overlap guards prevent new ticks from stacking.
    for (const task of scheduledTasks) {
      try { task.stop() } catch (e) { console.error('[shutdown] task.stop failed:', e) }
    }

    // Checkpoint WAL into the main DB file then close. Without this, recent
    // writes sit in the -wal sidecar; a deploy that copies only the main file
    // (and a SIGKILL after a stuck SIGTERM) loses those writes.
    try {
      sqlite.pragma('wal_checkpoint(TRUNCATE)')
      sqlite.close()
      console.log('[shutdown] DB checkpointed and closed')
    } catch (e) {
      console.error('[shutdown] DB close failed:', e)
    }

    process.exit(0)
  }

  process.on('SIGTERM', handle)
  process.on('SIGINT', handle)
}

export function startScheduler() {
  if (started) return
  started = true

  scheduledTasks.push(cron.schedule('*/5 * * * *', runFetch))
  scheduledTasks.push(cron.schedule('*/15 * * * *', runAutoGenerate))
  scheduledTasks.push(cron.schedule('0 3 * * *', runPrune))  // daily 03:00 — prune audit_log & old processed items
  scheduledTasks.push(cron.schedule('7 * * * *', runMarketsRefresh))  // hourly at :07 — keep market-relevance signal warm
  // Run an immediate market refresh on startup so the scorer has data to
  // boost against before the first hourly tick.
  void runMarketsRefresh()

  registerGracefulShutdown()

  console.log('[cron] scheduler started — fetch every 5min, generate every 15min, prune daily 03:00')
}
