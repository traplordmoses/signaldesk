import cron from 'node-cron'
import { db, sqlite } from '@/lib/db'
import { eventClusters, settings, generatedPosts } from '@/lib/db/schema'
import { eq, and, gt, isNull } from 'drizzle-orm'

let started = false

// Per-task overlap guards. Without these, a slow run of `runFetch` would let the
// next 5-min tick stack on top of itself — eventually saturating Together AI / DB.
const running = { fetch: false, generate: false, prune: false }

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

async function runAutoGenerate() {
  if (running.generate) {
    console.warn('[cron] auto-generate skipped — previous run still in progress')
    return
  }
  running.generate = true
  const startedAt = Date.now()
  try {
    const config = db.select().from(settings).where(eq(settings.id, 'singleton')).get()
    const threshold = config?.autoGenerateThreshold ?? 6.5
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000

    const candidates = db.select()
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

    if (candidates.length === 0) return

    console.log(`[cron] auto-generate: ${candidates.length} candidates`)

    const { generateSmartPosts } = await import('@/lib/ai/generator')

    for (const cluster of candidates) {
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

export function startScheduler() {
  if (started) return
  started = true

  cron.schedule('*/5 * * * *', runFetch)
  cron.schedule('*/15 * * * *', runAutoGenerate)
  cron.schedule('0 3 * * *', runPrune)  // daily 03:00 — prune audit_log & old processed items

  console.log('[cron] scheduler started — fetch every 5min, generate every 15min, prune daily 03:00')
}
