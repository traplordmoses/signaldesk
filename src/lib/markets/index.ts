/**
 * Market relevance signal — orchestrates Polymarket + Kalshi ingestion and
 * exposes `marketFit(headline)` for the news scorer.
 *
 * Refresh cycle: every 60 min the cron runs `refreshMarketTopics()` which
 *   1. fetches top markets/events from both platforms by 24h volume
 *   2. upserts them into `market_topics` (LLM extraction only on new rows)
 *   3. prunes rows we haven't seen in 30 days (markets that closed/resolved)
 *
 * marketFit(headline) is called inline by `scoreItem` — it's a cheap keyword
 * match against the cached entities, no API or LLM call. It is the SPINE of
 * the redesigned score: a flat +2 for mapping to ANY live market plus a
 * volume-scaled bonus (0..+5 total), and it unlocks the 10 ceiling. By keying
 * off what Polymarket / Kalshi are actively trading, the bot's coverage mirrors
 * the live prediction-market universe by construction.
 *
 * `relevanceBoost()` is kept as a thin numeric wrapper for back-compat.
 */

import { db, sqlite } from '../db'
import { marketTopics } from '../db/schema'
import { lt } from 'drizzle-orm'
import { fetchTopPolymarketMarkets } from './polymarket'
import { fetchTopKalshiEvents } from './kalshi'
import { upsertMarketTopic } from './topics'

const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
const MIN_ENTITY_LEN = 3   // skip very short entities to avoid false matches

// MarketFit shape: a flat reward for mapping to ANY live market, plus a
// volume-scaled bonus. A story tied to an actively-traded market is the
// strongest "we should post this" signal there is, so this dominates the score.
const MATCH_BONUS = 2.0        // any live-market match
const MAX_VOLUME_BONUS = 3.0   // additional, scaled by 24h volume
export const MAX_BOOST = 5.0   // MATCH_BONUS + MAX_VOLUME_BONUS

// In-memory cache of trending topics keyed by entity → the max-volume market
// that contains that entity (volume + its category). Refreshed inline on each
// `marketFit()` call when the cache is older than CACHE_TTL_MS, so scorer
// changes propagate without waiting for the cron tick.
interface CachedEntity {
  volume: number
  category: string | null
}
let entityCache: Map<string, CachedEntity> | null = null
let cacheBuiltAt = 0
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 min

interface CachedTopicRow {
  entities: string | null
  volume_24h: number | null
  category: string | null
}

function buildEntityCache(): Map<string, CachedEntity> {
  // Read all currently-tracked market topics. Limited by the 30-day prune
  // so the cache stays bounded.
  const rows = sqlite.prepare<[], CachedTopicRow>(
    'SELECT entities, volume_24h, category FROM market_topics'
  ).all()

  const cache = new Map<string, CachedEntity>()
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
      const prev = cache.get(key)
      if (!prev || vol > prev.volume) cache.set(key, { volume: vol, category: row.category ?? null })
    }
  }
  return cache
}

function getEntityCache(): Map<string, CachedEntity> {
  const now = Date.now()
  if (!entityCache || now - cacheBuiltAt > CACHE_TTL_MS) {
    entityCache = buildEntityCache()
    cacheBuiltAt = now
  }
  return entityCache
}

// Word-boundary entity matching. As the score's spine, marketFit must not fire
// on substrings: a 3-char entity like "eth" via `includes()` matches "Seth",
// "method", "ethics" — false market hits that would wrongly unlock the ceiling.
const ENTITY_RE_CACHE = new Map<string, RegExp>()
function entityMatch(haystack: string, entity: string): boolean {
  let re = ENTITY_RE_CACHE.get(entity)
  if (!re) {
    re = new RegExp(`(?:^|\\W)${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i')
    ENTITY_RE_CACHE.set(entity, re)
  }
  return re.test(haystack)
}

export interface MarketFit {
  boost: number           // 0..MAX_BOOST contribution to the news score
  matched: boolean        // did the headline map to any live market?
  maxVolume: number       // 24h volume of the strongest matched market
  category: string | null // that market's category (economics|politics|crypto|sports|culture|science|other)
}

/**
 * The market-fit spine. Returns how strongly a news headline maps to a
 * currently-active prediction market, plus the matched market's volume and
 * category (used for the ceiling rule and, later, prompt framing).
 *
 * Scoring shape:
 *   - For each entity in the cache, check if it appears in the headline (lc).
 *   - Take the MAX-volume match (not sum) — big markets dominate, but matching
 *     two small markets shouldn't compound past one big one.
 *   - boost = flat MATCH_BONUS for ANY match + a volume-scaled bonus:
 *       $10K→+0.5  $100K→+1.0  $1M→+1.5  $10M→+2.0  $100M→+2.5  $1B→+3.0(cap)
 *
 * Returns a no-match result when nothing matches OR the cache is empty (no
 * markets fetched yet — first cron tick hasn't run).
 */
export function marketFit(headline: string, summary: string = ''): MarketFit {
  const none: MarketFit = { boost: 0, matched: false, maxVolume: 0, category: null }

  const cache = getEntityCache()
  if (cache.size === 0) return none

  const haystack = `${headline} ${summary}`.toLowerCase()
  let maxVolume = 0
  let category: string | null = null

  for (const [entity, info] of cache) {
    if (info.volume > maxVolume && entityMatch(haystack, entity)) {
      maxVolume = info.volume
      category = info.category
    }
  }

  if (maxVolume <= 0) return none

  const volumeBonus = Math.min(MAX_VOLUME_BONUS, Math.max(0, 0.5 * (Math.log10(maxVolume) - 3)))
  const boost = Math.min(MAX_BOOST, MATCH_BONUS + volumeBonus)
  return { boost, matched: true, maxVolume, category }
}

/**
 * Back-compat numeric wrapper — returns just the marketFit boost. Retained for
 * any caller that wants the bare 0..MAX_BOOST number.
 */
export function relevanceBoost(headline: string, summary: string = ''): number {
  return marketFit(headline, summary).boost
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
