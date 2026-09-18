/**
 * Probly market directory: parsing, subject extraction and matching.
 *
 * The data source is a stopgap scrape of probly.com (no public API, no internal
 * feed yet), so the parser is the fragile part and gets pinned here against the
 * real payload shape. The matcher decides which market a Lark card links, and a
 * wrong link is worse than none, so the traps matter as much as the hits.
 */
import { describe, it, expect, beforeAll } from 'vitest'
// Isolated database: src/test/setup.ts points DB_PATH at a throwaway file before
// this module's imports run.

import {
  extractRawMarkets, normalizeMarket, marketSubjects, isMicroMarket, foldAccents,
  problyMarketFor, resetProblyCache, PROBLY_MARKETS_DDL, PROBLY_ALIASES_DDL,
} from './probly'
import { sqlite } from '@/lib/db'

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Wrap an object the way Next.js App Router ships it: a JSON string literal
 *  inside self.__next_f.push([1,"…"]), split across two chunks. */
function rscPage(obj: object): string {
  const encoded = JSON.stringify(JSON.stringify(obj)).slice(1, -1)   // escaped body
  const mid = Math.floor(encoded.length / 2)
  return `<html><script>self.__next_f.push([1,"${encoded.slice(0, mid)}"])</script>` +
    `<script>self.__next_f.push([1,"${encoded.slice(mid)}"])</script></html>`
}

describe('RSC flight payload parsing', () => {
  const market = {
    slug: 'epl-bre-che-2026-09-18-bre', event_slug: 'epl-bre-che-2026-09-18',
    question: 'Will Brentford FC win on 2026-09-18?', category: 'sports',
    outcome_prices: '["0.365","0.635"]', liquidity_num: 412345.5, end_date: 4102444800000,
    clob_token_ids: '["1","2"]',
  }

  it('reassembles chunks split mid-object and lifts the market out', () => {
    const found = extractRawMarkets(rscPage({ props: { markets: [market] } }))
    expect(found).toHaveLength(1)
    expect(found[0].slug).toBe('epl-bre-che-2026-09-18-bre')
  })

  it('returns nothing for a page with no flight payload rather than throwing', () => {
    expect(extractRawMarkets('<html>no rsc here</html>')).toEqual([])
  })

  it('normalises league, link and price', () => {
    const m = normalizeMarket(market, '/en/sports')!
    expect(m.league).toBe('Premier League')
    expect(m.url).toBe('https://www.probly.com/en/event/epl-bre-che-2026-09-18')
    expect(m.priceYes).toBe(0.365)
    expect(m.liquidity).toBe(412345.5)
  })

  it('labels markets from the front page as trending', () => {
    const { category: _c, ...noCategory } = market
    expect(normalizeMarket(noCategory, '/en')!.category).toBe('trending')
  })
})

// ── Subjects ────────────────────────────────────────────────────────────────

describe('marketSubjects — the four sports templates', () => {
  it.each([
    ['Will FC Bayern München win on 2026-09-18?', ['FC Bayern München']],
    ['Sevilla FC vs. FC Barcelona: O/U 3.5', ['Sevilla FC', 'FC Barcelona']],
    ['Spread: Brentford FC (-5.5)', ['Brentford FC']],
    ['Chelsea FC vs. Brentford FC', ['Chelsea FC', 'Brentford FC']],
    ['UFC 331: Alexandre Pantoja vs. Joshua Van (Flyweight, Main Card)', ['Alexandre Pantoja', 'Joshua Van']],
    ["Dana White's Contender Series: Zevan Hunt vs. Mayton Perea (Welterweight, Main Card)", ['Zevan Hunt', 'Mayton Perea']],
  ])('%s', (q, expected) => {
    expect(marketSubjects(q, 'sports')).toEqual(expected)
  })

  it('treats a non-sports question as one free-text subject', () => {
    const q = 'Will the Senate pass the Clarity Act by October 9?'
    expect(marketSubjects(q, 'politics')).toEqual([q])
  })

  it('recognises 5-minute price markets, which no story can ever cite', () => {
    expect(isMicroMarket('BNB Up or Down - September 18, 8:25AM-8:30AM ET')).toBe(true)
    expect(isMicroMarket('Will FC Barcelona win on 2026-09-19?')).toBe(false)
  })

  it('folds accents so a headline saying "München" still matches', () => {
    expect(foldAccents('bayern münchen')).toBe('bayern munchen')
  })
})

// ── Matching ────────────────────────────────────────────────────────────────

describe('problyMarketFor', () => {
  const FUTURE = Date.now() + 7 * 86_400_000
  const PAST = Date.now() - 86_400_000

  beforeAll(() => {
    sqlite.exec(PROBLY_MARKETS_DDL)
    sqlite.exec(PROBLY_ALIASES_DDL)
    const m = sqlite.prepare(`INSERT OR REPLACE INTO probly_markets
      (slug, event_slug, question, category, league, price_yes, liquidity, end_ms, url, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const a = sqlite.prepare('INSERT OR REPLACE INTO probly_aliases (subject, kind, aliases, resolved_at) VALUES (?, ?, ?, ?)')
    const now = Date.now()
    const market = (slug: string, q: string, cat: string, league: string | null, liq: number, end: number) =>
      m.run(slug, slug, q, cat, league, 0.5, liq, end, `https://www.probly.com/en/event/${slug}`, now)

    market('bun-bay', 'Will FC Bayern München win on 2026-09-18?', 'sports', 'Bundesliga', 900_000, FUTURE)
    market('fl1-asm', 'Will AS Monaco FC win on 2026-09-18?', 'sports', 'Ligue 1', 300_000, FUTURE)
    market('lal-bar', 'Will FC Barcelona win on 2026-09-19?', 'sports', 'La Liga', 2_600_000, FUTURE)
    market('lal-rma', 'Will Real Madrid CF win on 2026-09-19?', 'sports', 'La Liga', 1_900_000, FUTURE)
    market('lal-old', 'Will Sevilla FC win on 2026-09-01?', 'sports', 'La Liga', 5_000_000, PAST)
    market('sen-clar', 'Will the Senate pass the Clarity Act by October 9?', 'politics', null, 80_000, FUTURE)

    a.run('FC Bayern München', 'subject', '["bayern munich","bayern","bayern münchen"]', now)
    a.run('AS Monaco FC', 'subject', '["as monaco","monaco"]', now)
    a.run('FC Barcelona', 'subject', '["barcelona","barca"]', now)
    a.run('Real Madrid CF', 'subject', '["real madrid"]', now)
    a.run('Sevilla FC', 'subject', '["sevilla"]', now)
    a.run('Will the Senate pass the Clarity Act by October 9?', 'market', '["senate","clarity act"]', now)
    resetProblyCache()
  })

  it('links a sports story to its fixture', () => {
    expect(problyMarketFor('Bayern Munich cruise past Union Berlin', '', 'sports')?.league).toBe('Bundesliga')
  })

  it('matches through accents in the headline', () => {
    expect(problyMarketFor('Bayern München confirm squad', '', 'sports')).not.toBeNull()
  })

  it('does NOT link a non-sports story to a sports market that shares a name', () => {
    // "Monaco" is a club alias AND a principality; the sports gate is what stops this.
    expect(problyMarketFor('Monaco royal family announces new charity', '', 'pop_culture')).toBeNull()
  })

  it('picks the most liquid market when a story names two clubs', () => {
    const m = problyMarketFor('Real Madrid beat Barcelona in El Clasico', '', 'sports')
    expect(m?.question).toBe('Will FC Barcelona win on 2026-09-19?')
  })

  it('never links a market that has already closed', () => {
    expect(problyMarketFor('Sevilla sack their manager', '', 'sports')).toBeNull()
  })

  it('requires two entities before linking a free-text market', () => {
    expect(problyMarketFor('The Senate returns from recess on Monday', '', 'politics')).toBeNull()
    expect(problyMarketFor('Senate leaders schedule a Clarity Act vote', '', 'politics')?.question)
      .toBe('Will the Senate pass the Clarity Act by October 9?')
  })
})
