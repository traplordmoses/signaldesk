import cron from 'node-cron'
import { db, sqlite } from '@/lib/db'
import { eventClusters, settings, generatedPosts } from '@/lib/db/schema'
import { eq, and, gt, isNull, inArray } from 'drizzle-orm'
import { isWorthyHeadline } from '@/lib/ai/headline-filter'
import { extractKeywords, keywordOverlap } from '@/lib/news/clusterer'

let started = false

// Per-task overlap guards. Without these, a slow run of `runFetch` would let the
// next 5-min tick stack on top of itself — eventually saturating Together AI / DB.
const running = { fetch: false, generate: false, prune: false, markets: false, feedback: false }

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

// Cross-cycle category-diversity tuning. We dock a candidate DIVERSITY_PENALTY
// points for every card in the same category generated within DIVERSITY_WINDOW_MS.
// At 2.0/post a category posted twice recently effectively drops ~4 points,
// which is enough to let a strong story from a fresh category jump ahead.
const DIVERSITY_WINDOW_MS = 3 * 60 * 60 * 1000  // 3h look-back
const DIVERSITY_PENALTY = 2.0

// Near-duplicate guard: skip a candidate that shares ≥ DEDUP_MIN_OVERLAP topical
// keywords with a same-category post drafted within DEDUP_WINDOW_MS — i.e. "no
// similar posts in the same category in the same hour".
const DEDUP_WINDOW_MS = 60 * 60 * 1000  // 1h
const DEDUP_MIN_OVERLAP = 2

// Flatten an event_cluster's constituent_summaries JSON into one text blob for
// keyword extraction.
function summariesText(json: string | null): string {
  try { return (JSON.parse(json ?? '[]') as string[]).join(' ') } catch { return '' }
}

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
    const candidates: typeof rawCandidates = []
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

    // Cross-cycle diversity: look at the categories of cards generated in the
    // last few hours and down-rank candidates whose category we've been posting
    // a lot. During a big event (e.g. the World Cup) this stops 'sports' from
    // monopolizing the feed and lets crypto / tech / culture surface, so the
    // group gets a varied mix instead of ten of the same story.
    const recentCutoff = Date.now() - DIVERSITY_WINDOW_MS
    const recentClusterIds = db.select({ clusterId: generatedPosts.clusterId })
      .from(generatedPosts)
      .where(gt(generatedPosts.createdAt, recentCutoff))
      .all()
      .map(r => r.clusterId)
    const recentCatCount = new Map<string, number>()
    if (recentClusterIds.length > 0) {
      const recentCats = db.select({ category: eventClusters.category })
        .from(eventClusters)
        .where(inArray(eventClusters.id, recentClusterIds))
        .all()
      for (const c of recentCats) recentCatCount.set(c.category, (recentCatCount.get(c.category) ?? 0) + 1)
    }
    const effectiveScore = (c: typeof candidates[number]) =>
      (c.relevanceScore ?? 0) - DIVERSITY_PENALTY * (recentCatCount.get(c.category) ?? 0)

    // Best first by diversity-adjusted score, tie-broken by recency (newer first).
    candidates.sort((a, b) => {
      const d = effectiveScore(b) - effectiveScore(a)
      if (d !== 0) return d
      return (b.firstSeenAt ?? 0) - (a.firstSeenAt ?? 0)
    })

    // Per-cycle cap. Without this, a backlog (e.g. just after the daily cap
    // resets) dumps every queued candidate into the chat in one tick — 12
    // cards at once. Cap at 2 per cycle: the rest stay status='new' and
    // qualify on the next tick (5 min later). Combined with the 5-min cron
    // interval this paces delivery at ~1 card every 2-3 minutes instead of
    // batches landing all at once.
    // Near-duplicate guard: don't draft a story topically similar to one already
    // drafted in the SAME category within the last hour. The clusterer merges
    // look-alikes inside one batch, but a follow-up that ingests a few cycles
    // later forms a fresh cluster — this stops it (or a same-category twin)
    // re-posting in the same hour. Reuses the clusterer's keyword-overlap logic.
    const dedupCutoff = Date.now() - DEDUP_WINDOW_MS
    const recentDraftIds = db.select({ clusterId: generatedPosts.clusterId })
      .from(generatedPosts)
      .where(gt(generatedPosts.createdAt, dedupCutoff))
      .all()
      .map(r => r.clusterId)
    const recentStories = recentDraftIds.length
      ? db.select({
          category: eventClusters.category,
          canonicalHeadline: eventClusters.canonicalHeadline,
          constituentSummaries: eventClusters.constituentSummaries,
        })
        .from(eventClusters)
        .where(inArray(eventClusters.id, recentDraftIds))
        .all()
        .map(s => ({ category: s.category, kw: extractKeywords(`${s.canonicalHeadline} ${summariesText(s.constituentSummaries)}`) }))
      : []
    const candKwCache = new Map<string, Set<string>>()
    const isNearDup = (c: typeof candidates[number]): boolean => {
      if (recentStories.length === 0) return false
      let ck = candKwCache.get(c.id)
      if (!ck) {
        ck = extractKeywords(`${c.canonicalHeadline} ${summariesText(c.constituentSummaries)}`)
        candKwCache.set(c.id, ck)
      }
      return recentStories.some(r => r.category === c.category && keywordOverlap(ck!, r.kw) >= DEDUP_MIN_OVERLAP)
    }

    const PER_CYCLE_CAP = 2
    // Editorial diversity: don't draft two same-category cards in one cycle.
    // Walk the (diversity-adjusted) score order, picking the first of each unseen
    // category and skipping near-duplicates of recent posts. Then top up by rank.
    const trimmed: typeof candidates = []
    const usedCategories = new Set<string>()
    let dupSkipped = 0
    for (const c of candidates) {
      if (trimmed.length >= PER_CYCLE_CAP) break
      if (isNearDup(c)) { dupSkipped++; continue }
      if (usedCategories.has(c.category)) continue
      trimmed.push(c)
      usedCategories.add(c.category)
    }
    for (const c of candidates) {
      if (trimmed.length >= PER_CYCLE_CAP) break
      if (trimmed.includes(c)) continue
      if (isNearDup(c)) continue
      trimmed.push(c)
    }
    const deferred = candidates.length - trimmed.length

    console.log(`[cron] auto-generate: ${candidates.length} candidates${skippedLowSignal ? ` (${skippedLowSignal} skipped as low-signal)` : ''}${dupSkipped ? ` (${dupSkipped} near-dup skipped)` : ''}${deferred > 0 ? ` — generating top ${trimmed.length}, deferring ${deferred} to next cycle` : ''}`)

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
    if (durMs > 4 * 60 * 1000) {
      console.warn(`[cron] auto-generate took ${durMs}ms — approaching the 5-min tick interval`)
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

// Recompute source weight bonuses from the team's Approve/Reject decisions, so
// scraping leans toward sources reviewers actually approve. Gentle + gated on a
// minimum sample (see lib/feedback). Runs daily + once on startup.
async function runApprovalFeedback() {
  if (running.feedback) {
    console.warn('[cron] approval feedback skipped — previous run still in progress')
    return
  }
  running.feedback = true
  try {
    const { recomputeSourceWeightBonus } = await import('@/lib/feedback')
    const r = recomputeSourceWeightBonus()
    console.log(`[cron] approval feedback: ${r.adjusted} source weight-bonus(es) set from ${r.sampled} sampled source(s)`)
  } catch (e) {
    console.error('[cron] approval feedback failed:', (e as Error).message)
  } finally {
    running.feedback = false
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
  scheduledTasks.push(cron.schedule('*/5 * * * *', runAutoGenerate))
  scheduledTasks.push(cron.schedule('0 3 * * *', runPrune))  // daily 03:00 — prune audit_log & old processed items
  scheduledTasks.push(cron.schedule('7 * * * *', runMarketsRefresh))  // hourly at :07 — keep market-relevance signal warm
  // Run an immediate market refresh on startup so the scorer has data to
  // boost against before the first hourly tick.
  void runMarketsRefresh()

  scheduledTasks.push(cron.schedule('30 3 * * *', runApprovalFeedback))  // daily 03:30 — learn from approvals
  void runApprovalFeedback()

  registerGracefulShutdown()

  console.log('[cron] scheduler started — fetch every 5min, generate every 5min, prune daily 03:00')
}
