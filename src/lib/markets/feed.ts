import { sqlite } from '@/lib/db'
import type { ProblyMarket } from './probly'

export interface FeedMarket extends ProblyMarket { observedAt: number; bid: number; ask: number }
/** Contract for a future engineering-owned feed. Reject an invalid batch atomically. */
export function parseMarketFeed(input: unknown, now = Date.now()): FeedMarket[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { markets?: unknown }).markets)) throw new Error('Feed requires markets array')
  const rows = (input as { markets: unknown[] }).markets
  if (!rows.length || rows.length > 20_000) throw new Error('Invalid feed size')
  const ids = new Set<string>()
  return rows.map(raw => {
    const r = raw as FeedMarket
    if (!r || typeof r !== 'object' || !/^[a-zA-Z0-9_-]+$/.test(r.slug) || !/^[a-zA-Z0-9_-]+$/.test(r.eventSlug)
      || typeof r.question !== 'string' || r.question.length < 10 || typeof r.category !== 'string'
      || ![r.priceYes, r.bid, r.ask, r.liquidity, r.observedAt, r.endMs].every(v => typeof v === 'number' && Number.isFinite(v))
      || r.priceYes < 0 || r.priceYes > 1 || r.bid < 0 || r.ask > 1 || r.bid > r.ask || r.liquidity < 0
      || r.observedAt > now + 5000 || now - r.observedAt > 60_000 || ids.has(r.slug)) throw new Error('Invalid or stale market feed row')
    ids.add(r.slug)
    return { ...r, league: typeof r.league === 'string' ? r.league : null, url: `https://www.probly.com/en/event/${r.eventSlug}` }
  })
}
export async function readMarketFeed(): Promise<FeedMarket[]> {
  const endpoint = process.env.PROBLY_MARKET_FEED_URL
  if (!endpoint || new URL(endpoint).protocol !== 'https:') throw new Error('PROBLY_MARKET_FEED_URL must be HTTPS')
  const token = process.env.PROBLY_MARKET_FEED_TOKEN
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000), headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`Probly feed HTTP ${res.status}`)
  const rows = parseMarketFeed(await res.json())
  const insert = sqlite.prepare('INSERT OR IGNORE INTO market_quotes(market_id,observed_at,price,bid,ask,liquidity,source) VALUES (?,?,?,?,?,?,?)')
  sqlite.transaction(() => { for (const m of rows) insert.run(m.slug,m.observedAt,m.priceYes,m.bid,m.ask,m.liquidity,'probly_feed') })()
  return rows
}
let started = false
let running = false
export function startMarketFeed() {
  if (started || !process.env.PROBLY_MARKET_FEED_URL) return
  started = true
  const tick = async () => {
    if (running) return
    running = true
    try {
      const { refreshProblyMarkets } = await import('./probly')
      const r = await refreshProblyMarkets()
      if (r.kept) throw new Error(r.errors.join('; '))
      const { ingestExternalSignal } = await import('@/lib/news/social')
      const now = Date.now()
      const markets = sqlite.prepare('SELECT slug,question,url FROM probly_markets WHERE end_ms>?').all(now) as { slug:string; question:string; url:string }[]
      for (const m of markets) {
        const q = sqlite.prepare('SELECT observed_at,price,bid,ask,liquidity FROM market_quotes WHERE market_id=? AND observed_at>? ORDER BY observed_at DESC')
          .all(m.slug, now - 15 * 60_000) as {observed_at:number;price:number;bid:number;ask:number;liquidity:number}[]
        const latest=q[0], prior=q[1], base=q[q.length-1]
        if (!latest || !prior || !base || now-latest.observed_at>60_000 || latest.observed_at-base.observed_at<120_000) continue
        if ([latest,prior].some(v=>v.liquidity<10_000 || v.ask-v.bid>.05 || Math.abs(v.price-base.price)<.05)) continue
        if (Math.sign(latest.price-base.price)!==Math.sign(prior.price-base.price)) continue
        const previous=sqlite.prepare('SELECT last_alert_at FROM market_alerts WHERE market_id=?').get(m.slug) as {last_alert_at:number}|undefined
        if (previous && now-previous.last_alert_at<30*60_000) continue
        const title=`Probly market update: ${m.question}`
        await ingestExternalSignal({ id:`probly-${m.slug}-${latest.observed_at}`, title,
          text:`Probly YES price for “${m.question}” moved from ${Math.round(base.price*100)}% to ${Math.round(latest.price*100)}%, observed at ${new Date(latest.observed_at).toISOString()}. This is a market price, not confirmation of the outcome.`,
          url:m.url,publishedAt:latest.observed_at,sourceId:'probly_movement',sourceName:'Probly market data',category:'economics' })
        sqlite.prepare('INSERT OR REPLACE INTO market_alerts VALUES (?,?)').run(m.slug,now)
      }
      sqlite.prepare(`INSERT INTO newsroom_heartbeat(name,last_success,last_error) VALUES ('market-feed',?,NULL) ON CONFLICT(name) DO UPDATE SET last_success=excluded.last_success,last_error=NULL`).run(now)
    } catch(e) {
      console.error('[market-feed]',e)
      sqlite.prepare(`INSERT INTO newsroom_heartbeat(name,last_error) VALUES ('market-feed',?) ON CONFLICT(name) DO UPDATE SET last_error=excluded.last_error`).run(String(e).slice(0,300))
    } finally { running=false }
  }
  const timer=setInterval(()=>{void tick()},30_000);timer.unref();void tick()
}

export function freshMarketReply(postId: string, market: { marketId: string; question: string; url: string; matchType: string }, now=Date.now()): string|null {
  if (market.matchType !== 'direct') return null
  const q=sqlite.prepare("SELECT price,observed_at,bid,ask,liquidity FROM market_quotes WHERE market_id=? AND source='probly_feed' ORDER BY observed_at DESC LIMIT 1").get(market.marketId) as {price:number;observed_at:number;bid:number;ask:number;liquidity:number}|undefined
  if (!q || now-q.observed_at>60_000 || q.ask-q.bid>.05 || q.liquidity<1000) return null
  const text=`${market.question}\nProbly YES: ${Math.round(q.price*100)}% as of ${new Date(q.observed_at).toISOString().slice(11,16)} UTC.\n${market.url}`
  if (text.replace(market.url,'x'.repeat(23)).length>280) return null
  sqlite.prepare("INSERT INTO market_replies(post_id,content,quote_at) VALUES (?,?,?) ON CONFLICT(post_id) DO UPDATE SET content=excluded.content,quote_at=excluded.quote_at,state='pending',approved_by=NULL,approved_at=NULL").run(postId,text,q.observed_at)
  return text
}
