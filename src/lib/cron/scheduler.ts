import cron from 'node-cron'
import { db, sqlite } from '@/lib/db'
import { eventClusters, generatedPosts, settings } from '@/lib/db/schema'
import { and, eq, gt, desc, inArray } from 'drizzle-orm'
import { isWorthyHeadline } from '@/lib/ai/headline-filter'
import { detectCategory } from '@/lib/news/scorer'
import { topicalTokens, keywordOverlap } from '@/lib/news/clusterer'
import { TARGET_MIX, bucketForCategory } from '@/lib/mix'
import { evidenceFor } from '@/lib/editorial/evidence'
import { laneFor, decayedScore, routineDue } from '@/lib/editorial/priority'
import { problyMarketFor } from '@/lib/markets/probly'
import { drainOutbox } from '@/lib/lark/outbox'

const running = new Set<string>()
const tasks: ReturnType<typeof cron.schedule>[] = []
let started = false
let stopping = false
let pipelineTimer: ReturnType<typeof setTimeout> | undefined
let pipelineDirty = false

async function guarded(name: string, fn: () => Promise<void>) {
  if (stopping || running.has(name)) return
  running.add(name)
  sqlite.prepare(`INSERT INTO newsroom_heartbeat(name,last_started) VALUES (?,?)
    ON CONFLICT(name) DO UPDATE SET last_started=excluded.last_started`).run(name, Date.now())
  try {
    await fn()
    sqlite.prepare('UPDATE newsroom_heartbeat SET last_success=?,last_error=NULL WHERE name=?').run(Date.now(), name)
  } catch (e) {
    console.error(`[cron] ${name}:`, e)
    sqlite.prepare('UPDATE newsroom_heartbeat SET last_error=? WHERE name=?').run(String(e).slice(0, 500), name)
  } finally { running.delete(name) }
}

export function requestPipeline() {
  pipelineDirty = true
  if (pipelineTimer || stopping) return
  pipelineTimer = setTimeout(() => {
    pipelineTimer = undefined
    void guarded('pipeline', async () => {
      do {
        pipelineDirty = false
        const { clusterNewItems } = await import('@/lib/news/clusterer')
        await clusterNewItems({ rateNovelty: false })
        await runAutoGenerate()
        await drainOutbox()
      } while (pipelineDirty && !stopping)
    }).finally(() => { if (pipelineDirty && !stopping) requestPipeline() })
  }, 200)
}

/** Persisted lease survives restarts; one job for each event version. */
export function claimGeneration(clusterId: string, now = Date.now()): boolean {
  return sqlite.transaction(() => {
    sqlite.prepare(`INSERT OR IGNORE INTO generation_jobs(cluster_id,available_at) VALUES (?,?)`).run(clusterId, now)
    return sqlite.prepare(`UPDATE generation_jobs SET state='running',lease_until=?,attempts=attempts+1
      WHERE cluster_id=? AND attempts<3 AND ((state='pending' AND available_at<=?) OR (state='running' AND lease_until<=?))`)
      .run(now + 180_000, clusterId, now, now).changes === 1
  })()
}

export async function runAutoGenerate() {
  return guarded('generate', async () => {
    const now = Date.now()
    const config = db.select().from(settings).where(eq(settings.id, 'singleton')).get()
    if (!config || config.larkEnabled !== 1) return
    sqlite.prepare("UPDATE generated_posts SET status='expired',updated_at=? WHERE status='pending' AND created_at<?")
      .run(now, now - 8 * 3600_000)
    // Recover interrupted work without re-generating a post already committed before a crash.
    sqlite.prepare(`UPDATE event_clusters SET status='new' WHERE status='generation_failed' AND id IN
      (SELECT cluster_id FROM generation_jobs WHERE attempts<3 AND ((state='pending' AND available_at<=?) OR (state='running' AND lease_until<=?)))`).run(now, now)
    const recentPosts = db.select().from(generatedPosts).where(gt(generatedPosts.createdAt, now - 24 * 3600_000)).all()
    const limit = config.dailyPostLimit ?? 130
    if (recentPosts.length >= limit) return
    const clusters = recentPosts.length ? db.select().from(eventClusters).where(inArray(eventClusters.id, recentPosts.map(p => p.clusterId))).all() : []
    const buckets = new Map<string, number>()
    for (const c of clusters) {
      const e = evidenceFor(c)
      const bucket = bucketForCategory(detectCategory(c.canonicalHeadline, e?.text ?? ''), c.category)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
    }
    const laneOfPost = (signals: string | null) => { try { return JSON.parse(signals ?? '{}').lane } catch { return 'routine' } }
    const urgentPosts = recentPosts.filter(p => laneOfPost(p.signals) === 'urgent')
    const lastRoutine = recentPosts.filter(p => laneOfPost(p.signals) !== 'urgent').sort((a,b) => b.createdAt-a.createdAt)[0]
    const urgentBudget = urgentPosts.filter(p => p.createdAt > now - 3600_000).length < 3
      && !urgentPosts.some(p => p.createdAt > now - 60_000)
    const paced = routineDue(lastRoutine?.createdAt ?? null, config.postCooldownMinutes ?? 15, now)
    const candidates = db.select().from(eventClusters).where(and(eq(eventClusters.status, 'new'), eq(eventClusters.postCount, 0), gt(eventClusters.firstSeenAt, now - 6 * 3600_000))).all()
    const { noveltyFor, magnitudeFor, magnitudeBonus, MAGNITUDE_BYPASS } = await import('@/lib/ai/novelty')
    const novelty = noveltyFor(candidates.map(c => c.id))
    const magnitude = magnitudeFor(candidates.map(c => c.id))
    // Built lazily: only on rounds where a slot is actually due and a candidate
    // gets past the cheap filters, so the 30-second idle ticks never pay for it.
    const { loadHeatIndex, heatBonus } = await import('@/lib/editorial/heat')
    let heatIndex: ReturnType<typeof loadHeatIndex> | null = null
    const heat = () => (heatIndex ??= loadHeatIndex(now))
    const draftedRecently = recentPosts
      .filter(p => p.createdAt > now - 6 * 3600_000)
      .map(p => clusters.find(c => c.id === p.clusterId)?.canonicalHeadline)
      .filter((h): h is string => !!h)
    const ranked = candidates.flatMap(c => {
      if (!isWorthyHeadline(c.canonicalHeadline)) {
        db.update(eventClusters).set({ status: 'low_signal_skipped' }).where(eq(eventClusters.id, c.id)).run()
        return []
      }
      const e = evidenceFor(c)
      if (!e || now - e.publishedAt > 4 * 3600_000) return []
      const category = detectCategory(c.canonicalHeadline, e.text)
      const match = problyMarketFor(c.canonicalHeadline, e.text, category)
      const lane = laneFor(e, match != null, c.riskLevel, now)
      if (lane === 'urgent' ? !urgentBudget : !paced) return []
      // A story rated magnitude 7+ competes even below the keyword-relevance gate:
      // relevance measures category keywords and market fit, not importance.
      const mag = magnitude.get(c.id)
      if ((c.relevanceScore ?? 0) < (config.autoGenerateThreshold ?? 6.5) && lane !== 'urgent' && (mag ?? 0) < MAGNITUDE_BYPASS) return []
      // Routine generation cannot exhaust the last 10% of the daily budget reserved for urgent news.
      if (lane !== 'urgent' && recentPosts.length >= Math.floor(limit * .9)) return []
      if (!c.parentClusterId) {
        const kw = topicalTokens(c.canonicalHeadline)
        const dup = clusters.some(prev => {
          if (!recentPosts.some(p => p.clusterId === prev.id && p.createdAt > now - 2 * 3600_000)) return false
          const other = topicalTokens(prev.canonicalHeadline)
          return keywordOverlap(kw, other) >= 4 && keywordOverlap(kw, other) / Math.max(1, Math.min(kw.size, other.size)) >= .65
        })
        if (dup) return []
      }
      const bucket = bucketForCategory(category, c.category)
      const target = TARGET_MIX[bucket] ?? 0
      const actual = clusters.length ? (buckets.get(bucket) ?? 0) / clusters.length : target
      // Magnitude (how big, per the model) and heat (how many outlets are running
      // it) are what let a defining story beat the 10.0 filler that relevance
      // can't tell it apart from. Both are withheld once the story has already
      // been drafted in the last 6h — otherwise every other outlet's copy of the
      // same verdict would win the next slots too. A cluster marked as a material
      // update of a drafted story (parentClusterId) is a new development and keeps
      // them.
      const covered = !c.parentClusterId && draftedRecently.some(h => heat().sameStoryAs(h, c.canonicalHeadline))
      const bigness = covered ? 0 : magnitudeBonus(mag) + heatBonus(heat().coverage(c.canonicalHeadline, c.id).outlets)
      const score = decayedScore(c.relevanceScore ?? 0, e.publishedAt, now) + 20 * (target - actual)
        + (match ? 1.5 : 0) + ((novelty.get(c.id) ?? 0) >= 8 ? 1.5 : 0) + bigness
      return [{ c, score, lane, publishedAt: e.publishedAt }]
    }).sort((a,b) => Number(b.lane === 'urgent') - Number(a.lane === 'urgent') || b.score-a.score || b.publishedAt-a.publishedAt)
    const { generateSmartPosts } = await import('@/lib/ai/generator')
    for (const { c } of ranked) {
      if (!claimGeneration(c.id, now)) continue
      try {
        const posts = await generateSmartPosts(c)
        if (!posts.length) throw new Error('Draft generation failed; see generation audit')
        sqlite.prepare("UPDATE generation_jobs SET state='done',lease_until=NULL,last_error=NULL WHERE cluster_id=?").run(c.id)
      } catch (e) {
        const job = sqlite.prepare('SELECT attempts FROM generation_jobs WHERE cluster_id=?').get(c.id) as { attempts: number }
        sqlite.prepare("UPDATE generation_jobs SET state=?,available_at=?,lease_until=NULL,last_error=? WHERE cluster_id=?")
          .run(job.attempts >= 3 ? 'failed' : 'pending', Date.now() + 60_000 * 2 ** job.attempts, String(e).slice(0,500), c.id)
      }
      break
    }
  })
}

async function fetchNews() {
  await guarded('fetch', async () => {
    const { fetchAllSources } = await import('@/lib/news/fetcher')
    const r = await fetchAllSources(requestPipeline)
    console.log(`[cron] fetch: ${r.ingested} ingested, ${r.errors} errors`)
    requestPipeline()
  })
}
async function refreshMarkets() {
  await guarded('probly', async () => {
    const { refreshProblyMarkets } = await import('@/lib/markets/probly')
    const r = await refreshProblyMarkets()
    if (r.kept || r.errors.length) throw new Error(`Probly refresh: ${r.errors.join('; ')}`)
  })
  await guarded('competitor-markets', async () => {
    const { refreshMarketTopics } = await import('@/lib/markets')
    await refreshMarketTopics()
  })
}
async function rateNovelty() {
  await guarded('novelty', async () => {
    const { applyNovelty, CLUSTER_NOVELTY_DDL } = await import('@/lib/ai/novelty')
    sqlite.exec(CLUSTER_NOVELTY_DDL)
    const rows = sqlite.prepare(`SELECT id,canonical_headline headline,relevance_score baseScore FROM event_clusters
      WHERE status='new' AND first_seen_at>? AND id NOT IN (SELECT cluster_id FROM cluster_novelty)
      ORDER BY first_seen_at DESC LIMIT 120`).all(Date.now() - 4 * 3600_000) as { id: string; headline: string; baseScore: number }[]
    await applyNovelty(rows)
  })
}
export function startScheduler() {
  if (started || process.env.SIGNALDESK_DISABLE_SCHEDULER === '1') return
  started = true
  // Recovery only for recent undelivered drafts; never replay historical cards.
  sqlite.prepare(`INSERT OR IGNORE INTO delivery_outbox(post_id,available_at,created_at)
    SELECT id,?,created_at FROM generated_posts WHERE status='pending' AND lark_sent_at IS NULL AND created_at>?`)
    .run(Date.now(), Date.now() - 8 * 3600_000)
  tasks.push(cron.schedule('*/5 * * * *', fetchNews))
  tasks.push(cron.schedule('15 * * * * *', () => guarded('primary-fetch', async () => {
    const { fetchAllSources } = await import('@/lib/news/fetcher')
    await fetchAllSources(requestPipeline, true)
  })))
  tasks.push(cron.schedule('*/30 * * * * *', () => { requestPipeline(); void drainOutbox() }))
  tasks.push(cron.schedule('7 * * * *', refreshMarkets))
  tasks.push(cron.schedule('2-59/5 * * * *', rateNovelty))
  tasks.push(cron.schedule('30 3 * * *', () => guarded('maintenance', async () => {
    const { recomputeSourceWeightBonus } = await import('@/lib/feedback')
    recomputeSourceWeightBonus()
    sqlite.prepare('DELETE FROM audit_log WHERE created_at<?').run(Date.now() - 30 * 86400_000)
    sqlite.prepare('DELETE FROM news_items WHERE ingested_at<? AND is_processed=1').run(Date.now() - 14 * 86400_000)
    sqlite.prepare('DELETE FROM market_quotes WHERE observed_at<?').run(Date.now() - 7 * 86400_000)
  })))
  void refreshMarkets()
  void fetchNews()
  void import('@/lib/markets/feed').then(m => m.startMarketFeed())
  void import('@/lib/news/social').then(m => m.startSocialStream())
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    if (pipelineTimer) clearTimeout(pipelineTimer)
    for (const task of tasks) task.stop()
    const deadline = Date.now() + 25_000
    while (running.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    // Do not close the DB under an in-flight callback/outbox. The OS closes it;
    // SQLite WAL recovery and persisted leases resume interrupted work safely.
    try { sqlite.pragma('wal_checkpoint(PASSIVE)') } catch { /* recovery on startup */ }
    process.exit(0)
  }
  process.once('SIGTERM', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() })
  console.log('[cron] newsroom: streaming ingestion, 30s selection, durable delivery')
}
