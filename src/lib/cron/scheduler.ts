import cron from 'node-cron'
import { db } from '@/lib/db'
import { eventClusters, settings, generatedPosts } from '@/lib/db/schema'
import { eq, and, gt } from 'drizzle-orm'

let started = false

async function runFetch() {
  try {
    const { fetchAllSources } = await import('@/lib/news/fetcher')
    const { clusterNewItems } = await import('@/lib/news/clusterer')
    const { ingested, errors } = await fetchAllSources()
    const clustered = await clusterNewItems()
    console.log(`[cron] fetch: +${ingested} articles, +${clustered} clusters, ${errors} errors`)
  } catch (e) {
    console.error('[cron] fetch failed:', e)
  }
}

async function runAutoGenerate() {
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
            const freshPosts = db.select()
              .from(generatedPosts)
              .where(eq(generatedPosts.clusterId, cluster.id))
              .all()
            const messageId = await sendClusterToLark(cluster, freshPosts)
            if (messageId) {
              for (const p of freshPosts) {
                db.update(generatedPosts)
                  .set({ larkMessageId: messageId, larkSentAt: Date.now() })
                  .where(eq(generatedPosts.id, p.id))
                  .run()
              }
              console.log(`[cron] sent to Lark: ${cluster.canonicalHeadline.slice(0, 50)}`)
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
  }
}

export function startScheduler() {
  if (started) return
  started = true

  cron.schedule('*/5 * * * *', runFetch)
  cron.schedule('*/15 * * * *', runAutoGenerate)

  console.log('[cron] scheduler started — fetch every 5min, generate every 15min')
}
