/**
 * Coverage heat: how many distinct outlets are reporting the same story right now.
 *
 * Why: nothing else in selection measures how BIG a story is. Relevance tops out
 * at 10 and routine stories sit there all day, so on 2026-09-25 the Man City
 * guilty verdict (8.5) lost every slot to things like a trading-card sale (10.0)
 * and a child asking an astronaut a question (8.5) — while The Athletic, CBS, Al
 * Jazeera, BBC, Sky, the Guardian, Bloomberg and the FT were all running it.
 * "Everyone is covering this" is the most reliable magnitude signal there is, and
 * it is free: the bot has already fetched those articles.
 *
 * Counted by outlet (registrable domain), not by feed, so BBC Sport + BBC
 * Football is one outlet and ten copies from one site can't fake a big story.
 * Aggregator feeds (Google News, Reddit) count once per feed, because their URLs
 * don't reveal the underlying publisher.
 *
 * Pure: the index is built from plain rows so the same code runs in production
 * and in the replay that calibrated it.
 */
import { sqlite } from '@/lib/db'
import { topicalTokens, sameStory, buildDocFrequency, distinctivenessCutoff } from '@/lib/news/clusterer'

/** Coverage is counted over this window. */
export const HEAT_WINDOW_MS = 3 * 60 * 60_000
/** Token distinctiveness is measured over this window (same as the clusterer). */
export const HEAT_DF_WINDOW_MS = 6 * 60 * 60_000
/** Outlets that come free: one or two sites running a story says nothing about size. */
export const HEAT_FREE_OUTLETS = 2
/**
 * Selection points per outlet beyond the free ones. Deliberately secondary to
 * magnitude: at 1.5/outlet a media-industry item ("White House video coverage
 * returns as networks resume TV pool", magnitude 5) topped the replayed
 * afternoon purely because six media outlets were covering news about
 * themselves. Heat corroborates a big story; it shouldn't manufacture one.
 */
export const HEAT_POINTS_PER_OUTLET = 0.75
/** Cap, so a mega-story can't swamp the mix steering entirely. */
export const HEAT_MAX_BONUS = 4

export interface HeatItem {
  title: string
  url: string
  sourceId: string
  clusterId: string | null
}

const AGGREGATOR_HOSTS = /(^|\.)(news\.google\.com|reddit\.com|feedx\.net)$/

/** The publishing organisation behind an item, as a stable key. */
export function outletKey(url: string, sourceId: string): string {
  let host: string
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return `feed:${sourceId}` }
  if (AGGREGATOR_HOSTS.test(host)) return `feed:${sourceId}`
  const parts = host.split('.')
  // Registrable domain: last two labels, or three for co.uk / com.au style.
  if (parts.length >= 3 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.')
  }
  return parts.slice(-2).join('.')
}

export class HeatIndex {
  private readonly tokens: Set<string>[]
  private readonly inverted = new Map<string, number[]>()
  private readonly byCluster = new Map<string, number[]>()

  constructor(
    private readonly items: HeatItem[],
    private readonly df: Map<string, number>,
    private readonly dfMax: number,
  ) {
    this.tokens = items.map(i => topicalTokens(i.title))
    this.tokens.forEach((toks, idx) => {
      for (const t of toks) {
        if ((df.get(t) ?? 1) > dfMax) continue   // only distinctive tokens are worth indexing
        const list = this.inverted.get(t)
        if (list) list.push(idx); else this.inverted.set(t, [idx])
      }
      const cid = items[idx].clusterId
      if (cid) {
        const list = this.byCluster.get(cid)
        if (list) list.push(idx); else this.byCluster.set(cid, [idx])
      }
    })
  }

  /** Same event? Uses this index's frequencies, so it matches coverage counting. */
  sameStoryAs(a: string, b: string): boolean {
    return sameStory(a, b, this.df, this.dfMax)
  }

  /** Distinct outlets covering the story behind `headline` (and its own cluster). */
  coverage(headline: string, clusterId: string | null): { outlets: number; keys: string[] } {
    const matched = new Set<number>(clusterId ? this.byCluster.get(clusterId) ?? [] : [])

    // Shortlist through the inverted index — an item must share at least two
    // distinctive tokens to have any chance of passing sameStory — then confirm.
    const shared = new Map<number, number>()
    for (const t of topicalTokens(headline)) {
      for (const idx of this.inverted.get(t) ?? []) shared.set(idx, (shared.get(idx) ?? 0) + 1)
    }
    for (const [idx, n] of shared) {
      if (n >= 2 && !matched.has(idx) && sameStory(headline, this.items[idx].title, this.df, this.dfMax)) matched.add(idx)
    }

    const keys = new Set<string>()
    for (const idx of matched) keys.add(outletKey(this.items[idx].url, this.items[idx].sourceId))
    return { outlets: keys.size, keys: [...keys].sort() }
  }
}

/** Selection points for a coverage count. */
export function heatBonus(outlets: number): number {
  return Math.min(HEAT_MAX_BONUS, Math.max(0, outlets - HEAT_FREE_OUTLETS) * HEAT_POINTS_PER_OUTLET)
}

/** Build from rows. `window` = items for counting, `dfCorpus` = texts for distinctiveness. */
export function buildHeatIndex(window: HeatItem[], dfCorpus: string[]): HeatIndex {
  return new HeatIndex(window, buildDocFrequency(dfCorpus), distinctivenessCutoff(dfCorpus.length))
}

/** Production loader. One query per selection round that actually has a slot to fill. */
export function loadHeatIndex(now = Date.now()): HeatIndex {
  const rows = sqlite.prepare(`
    SELECT title, COALESCE(summary,'') AS summary, url, source_id, cluster_id, ingested_at
    FROM news_items WHERE ingested_at > ?`).all(now - HEAT_DF_WINDOW_MS) as Array<{
      title: string; summary: string; url: string; source_id: string; cluster_id: string | null; ingested_at: number
    }>
  const window = rows
    .filter(r => r.ingested_at > now - HEAT_WINDOW_MS)
    .map(r => ({ title: r.title, url: r.url, sourceId: r.source_id, clusterId: r.cluster_id }))
  return buildHeatIndex(window, rows.map(r => `${r.title} ${r.summary}`))
}
