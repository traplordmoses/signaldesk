/**
 * Market relevance signal — orchestrates Polymarket + Kalshi ingestion and
 * exposes `relevanceBoost(headline)` for the news scorer.
 *
 * Refresh cycle: every 60 min the cron runs `refreshMarketTopics()` which
 *   1. fetches top markets/events from both platforms by 24h volume
 *   2. upserts them into `market_topics` (LLM extraction only on new rows)
 *   3. prunes rows we haven't seen in 30 days (markets that closed/resolved)
 *
 * relevanceBoost(headline) is called inline by `scoreItem` — it's a cheap
 * keyword match against the cached entities, no API or LLM call. Returns
 * a +0..3 bonus that's added to the existing 0-10 base score.
 *
 * The bonus magnitude is volume-weighted: matching a $50M-volume market
 * gets a bigger boost than matching a $5K-volume one. This skews the bot
 * toward generating tweets on stories the audience is actively watching.
 */

import { db, sqlite } from '../db'
import { marketTopics } from '../db/schema'
import { lt } from 'drizzle-orm'
import { fetchTopPolymarketMarkets } from './polymarket'
import { fetchTopKalshiEvents } from './kalshi'
import { upsertMarketTopic } from './topics'

const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
const MAX_BOOST = 3.0
const MIN_ENTITY_LEN = 3   // skip very short entities to avoid false matches

// In-memory cache of trending topics keyed by entity → max-volume of any
// market that contains that entity. Refreshed inline on each
// `relevanceBoost()` call when the cache is older than CACHE_TTL_MS, so
// scorer changes propagate without waiting for the cron tick.
let entityCache: Map<string, number> | null = null
let cacheBuiltAt = 0
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 min

interface CachedTopicRow {
  entities: string | null
  volume_24h: number | null
}

function buildEntityCache(): Map<string, number> {
  // Read all currently-tracked market topics. Limited by the 30-day prune
  // so the cache stays bounded.
  const rows = sqlite.prepare<[], CachedTopicRow>(
    'SELECT entities, volume_24h FROM market_topics'
  ).all()

  const cache = new Map<string, number>()
  for (const row of rows) {
    if (!row.entities) continue
    let entities: string[]
    try {
      entities = JSON.parse(row.entities) as string[]
    } catch { continue }
    const vol = Number(row.volume_24h ?? 0)
    if (!Number.isFinite(vol) || vol <= 0) continue
    for (const ent of entities) {
      const key = ent.toLowerCase().trim()
      if (key.length < MIN_ENTITY_LEN) continue
      const prev = cache.get(key) ?? 0
      if (vol > prev) cache.set(key, vol)
    }
  }
  return cache
}

function getEntityCache(): Map<string, number> {
  const now = Date.now()
  if (!entityCache || now - cacheBuiltAt > CACHE_TTL_MS) {
    entityCache = buildEntityCache()
    cacheBuiltAt = now
  }
  return entityCache
}

/**
 * Returns a +0..3 score boost based on how strongly a news headline maps to
 * currently-active prediction-market entities.
 *
 * Scoring shape:
 *   - For each entity in the cache, check if it appears in the headline (lc).
 *   - If multiple matches, take the MAX volume (not sum) — big markets
 *     dominate, but matching two small markets shouldn't compound past one
 *     big one.
 *   - Map matched volume to a boost on a log scale, capped at MAX_BOOST.
 *
 * Returns 0 when nothing matches OR when the cache is empty (no markets
 * fetched yet — first cron tick hasn't run).
 */
export function relevanceBoost(headline: string, summary: string = ''): number {
  const cache = getEntityCache()
  if (cache.size === 0) return 0

  const haystack = `${headline} ${summary}`.toLowerCase()
  let maxVolume = 0

  for (const [entity, vol] of cache) {
    if (haystack.includes(entity)) {
      if (vol > maxVolume) maxVolume = vol
    }
  }

  if (maxVolume <= 0) return 0

  // Log-scale: $1K = 0.5, $10K = 1.0, $100K = 1.5, $1M = 2.0, $10M = 2.5,
  // $100M+ = 3.0. Caps at MAX_BOOST.
  const boost = 0.5 * Math.log10(maxVolume)
  return Math.min(MAX_BOOST, Math.max(0, boost))
}

/**
 * Fetch from both platforms, upsert into the cache, prune stale rows.
 * Called by the cron once per hour. New markets trigger one LLM call each
 * for topic extraction; existing markets are just touched.
 */
export async function refreshMarketTopics(): Promise<{
  polymarket: number
  kalshi: number
  newExtractions: number
  errors: string[]
}> {
  const errors: string[] = []
  const beforeCount = sqlite.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM market_topics').get()?.c ?? 0

  let poly: Awaited<ReturnType<typeof fetchTopPolymarketMarkets>> = []
  try { poly = await fetchTopPolymarketMarkets(50) }
  catch (e) { errors.push(`polymarket: ${(e as Error).message}`) }

  let kalshi: Awaited<ReturnType<typeof fetchTopKalshiEvents>> = []
  try { kalshi = await fetchTopKalshiEvents(50) }
  catch (e) { errors.push(`kalshi: ${(e as Error).message}`) }

  for (const m of [...poly, ...kalshi]) {
    try { await upsertMarketTopic(m) }
    catch (e) { errors.push(`upsert ${m.source}:${m.marketId}: ${(e as Error).message}`) }
  }

  // Prune markets we haven't seen in 30+ days.
  const cutoff = Date.now() - STALE_TTL_MS
  db.delete(marketTopics).where(lt(marketTopics.lastSeenAt, cutoff)).run()

  // Invalidate in-memory cache so next relevanceBoost() rebuilds.
  entityCache = null

  const afterCount = sqlite.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM market_topics').get()?.c ?? 0

  return {
    polymarket: poly.length,
    kalshi: kalshi.length,
    newExtractions: Math.max(0, afterCount - beforeCount),
    errors,
  }
}
