/**
 * Kalshi public events API client.
 *
 * Pulls top events (not raw markets — Kalshi's `markets` endpoint returns
 * sub-leg components like "yes Kelly Oubre Jr.: 10+,yes Nickeil…" that
 * aren't human-readable). The events endpoint surfaces the parent question
 * with clean titles. Free, no auth required.
 *
 * Note: Kalshi's events response doesn't directly include volume per event
 * in the v2 schema, so we sort by `volume_24h` if present, falling back to
 * `open_interest` or to insertion order. We're using this only as a
 * relevance signal, so a coarse ranking is fine.
 *
 * Docs: https://trading-api.readme.io/reference/getevents
 */

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

export interface RawMarket {
  source: 'kalshi'
  marketId: string  // event_ticker
  question: string  // event title
  volume24h: number // best-effort; may be 0 if not surfaced at the event level
  closesAt: number | null
}

interface KalshiEvent {
  event_ticker: string
  series_ticker?: string
  title?: string
  sub_title?: string
  category?: string
  status?: 'open' | 'closed' | 'settled' | string
  // Volume / open interest fields are inconsistently named across versions:
  volume_24h?: number
  open_interest?: number
  expected_expiration_time?: string  // ISO
}

interface KalshiEventsResponse {
  events: KalshiEvent[]
  cursor?: string
}

/**
 * Fetch top open events from Kalshi. We pull a larger page than we'll
 * actually use (so we can client-sort by volume) and trim to `limit`.
 */
export async function fetchTopKalshiEvents(limit: number = 50): Promise<RawMarket[]> {
  const url = `${KALSHI_BASE}/events?limit=200&status=open`

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Kalshi events ${res.status}: ${res.statusText}`)
  }

  const data = (await res.json()) as KalshiEventsResponse
  const events = data.events ?? []
  const now = Date.now()

  const candidates: RawMarket[] = []
  for (const e of events) {
    if (e.status && e.status !== 'open') continue
    const title = (e.title ?? e.sub_title ?? '').trim()
    if (!title) continue
    const closesAt = e.expected_expiration_time ? new Date(e.expected_expiration_time).getTime() : null
    if (closesAt !== null && closesAt < now) continue

    const volume24h = e.volume_24h ?? e.open_interest ?? 0

    candidates.push({
      source: 'kalshi',
      marketId: e.event_ticker,
      question: title,
      volume24h: Number.isFinite(volume24h) ? Number(volume24h) : 0,
      closesAt,
    })
  }

  // Sort by volume desc, take top N
  candidates.sort((a, b) => b.volume24h - a.volume24h)
  return candidates.slice(0, limit)
}
