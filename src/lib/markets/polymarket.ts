/**
 * Polymarket Gamma API client.
 *
 * Pulls top markets by 24h volume — used by the news scorer as a relevance
 * signal: news headlines that match the topic of an active high-volume
 * Polymarket event get a score boost. Free, no auth required.
 *
 * Docs: https://docs.polymarket.com/#gamma-markets-api
 */

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

export interface RawMarket {
  source: 'polymarket'
  marketId: string       // hex id
  question: string       // human-readable question
  volume24h: number      // dollars
  closesAt: number | null // ms epoch
}

interface PolymarketGammaMarket {
  id: string
  question: string
  volume24hr?: string | number
  end_date_iso?: string
  active?: boolean
  closed?: boolean
}

/**
 * Fetch the top N most-traded active Polymarket markets by 24h volume.
 *
 * Returns markets that are open (not closed, not expired) and ranked by
 * volume24hr descending. We filter client-side for an extra safety net
 * since the API's `active`+`closed` filters are reliable but not perfect.
 */
export async function fetchTopPolymarketMarkets(limit: number = 50): Promise<RawMarket[]> {
  const url = `${GAMMA_BASE}/markets?limit=${limit}&order=volume24hr&ascending=false&active=true&closed=false`

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Polymarket gamma ${res.status}: ${res.statusText}`)
  }

  const raw = (await res.json()) as PolymarketGammaMarket[]

  const now = Date.now()
  const out: RawMarket[] = []
  for (const m of raw) {
    if (m.closed) continue
    if (m.active === false) continue
    const closesAt = m.end_date_iso ? new Date(m.end_date_iso).getTime() : null
    if (closesAt !== null && closesAt < now) continue  // expired
    const volume24h = typeof m.volume24hr === 'number' ? m.volume24hr : Number(m.volume24hr ?? 0)
    if (!Number.isFinite(volume24h) || volume24h <= 0) continue
    if (!m.question) continue

    out.push({
      source: 'polymarket',
      marketId: m.id,
      question: m.question,
      volume24h,
      closesAt,
    })
  }

  return out
}
