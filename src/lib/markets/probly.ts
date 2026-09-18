/**
 * Probly markets — the platform this bot actually posts for.
 *
 * Why this exists: the scorer's "market fit" used to be measured only against
 * Polymarket (4,500 markets) and Kalshi (60). Probly — the account these posts
 * go out on — had zero markets in that table, so the bot steered toward what
 * *Polymarket* lists. Sports is where that showed: drafts were NFL fantasy picks
 * and ESPN contracts while Probly lists EPL, La Liga, Serie A and UFC.
 *
 * ── STOPGAP DATA SOURCE ─────────────────────────────────────────────────────
 * Probly has no public API and engineering can't provide a market feed yet.
 * The pages are Next.js App Router, server-rendered, with market objects
 * embedded in the RSC flight payload (the self.__next_f.push(...) chunks). This
 * reads the same bytes a browser already receives and lifts the market objects
 * out. Ported from the Fly prototype's fetch_markets.py.
 *
 * It WILL break silently on a Probly frontend change that renames
 * `clob_token_ids` or stops server-rendering markets. refreshProblyMarkets()
 * therefore never wipes the table on a failed or empty fetch — a stale market
 * list is far better than none. When engineering provides a feed, replace
 * fetchProblyMarkets() and nothing downstream changes.
 *
 * Politeness, on purpose: eight category pages, sequential, a pause between
 * requests, an identifying User-Agent, hourly.
 */
import { sqlite } from '@/lib/db'

const BASE = 'https://www.probly.com'

const CATEGORY_PAGES = [
  '/en',
  '/en/crypto',
  '/en/politics',
  '/en/sports',
  '/en/geopolitics',
  '/en/finance',
  '/en/economy',
  '/en/commodities',
]

const UA = `SignalDeskBot/1.0 (${process.env.NEXT_PUBLIC_APP_URL ?? 'local development'}; Probly newsroom tooling)`
const PAGE_DELAY_MS = 1500
const FETCH_TIMEOUT_MS = 30_000

const PUSH_RE = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
const MARKER = '"clob_token_ids"'

// Slug prefix -> league. Probly encodes the competition in the first slug
// segment ("epl-ars-che-2026-09-20-ars"). Measured on the live sports page.
export const LEAGUES: Record<string, string> = {
  epl: 'Premier League',
  lal: 'La Liga',
  sea: 'Serie A',
  bun: 'Bundesliga',
  fl1: 'Ligue 1',
  por: 'Primeira Liga',
  mls: 'MLS',
  bra: 'Brasileirão',
  uel: 'Europa League',
  ucl: 'Champions League',
  ufc: 'UFC',
}

export interface ProblyMarket {
  slug: string
  eventSlug: string
  question: string
  category: string
  league: string | null
  priceYes: number
  liquidity: number
  endMs: number | null
  url: string
}

// ── RSC flight payload parsing ──────────────────────────────────────────────

/** Join every RSC chunk and unescape it back into one string. */
export function reassembleFlight(html: string): string {
  const chunks: string[] = []
  for (const m of html.matchAll(PUSH_RE)) chunks.push(m[1])
  if (chunks.length === 0) return ''
  const joined = chunks.join('')
  try {
    // The captured group is the body of a JSON string literal.
    return JSON.parse(`"${joined}"`) as string
  } catch {
    return joined.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
}

/** Walk backwards from idx to the opening brace of the enclosing object. */
function objectStart(text: string, idx: number): number | null {
  let depth = 0
  for (let j = idx; j > Math.max(0, idx - 12_000); j--) {
    const c = text[j]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) return j
      depth--
    }
  }
  return null
}

/** String-aware brace match forward from start. */
function objectEnd(text: string, start: number): number | null {
  let depth = 0
  let inStr = false
  const limit = Math.min(text.length, start + 20_000)
  for (let i = start; i < limit; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

export function extractRawMarkets(html: string): Record<string, unknown>[] {
  const text = reassembleFlight(html)
  if (!text) return []
  const found: Record<string, unknown>[] = []
  let i = -1
  for (;;) {
    i = text.indexOf(MARKER, i + 1)
    if (i < 0) break
    const start = objectStart(text, i)
    if (start == null) continue
    const end = objectEnd(text, start)
    if (end == null) continue
    try {
      found.push(JSON.parse(text.slice(start, end + 1)))
    } catch { /* not a clean object — skip */ }
  }
  return found
}

// ── Shaping ─────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : null
}

function parseList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

export function normalizeMarket(m: Record<string, unknown>, page: string): ProblyMarket | null {
  const question = (m.question ?? m.title) as string | undefined
  const slug = m.slug as string | undefined
  if (!question || !slug) return null

  const prices = parseList(m.outcome_prices)
  const priceYes = num(prices[0])
  if (priceYes == null) return null

  // Market slug and event slug differ; the public link is keyed on the event.
  const eventSlug = (m.parent_event_slug ?? m.event_slug ?? slug) as string
  const prefix = slug.split('-')[0]
  const pageCategory = page === '/en' ? 'trending' : page.replace('/en/', '')

  return {
    slug,
    eventSlug,
    question: question.trim(),
    category: ((m.category as string) || pageCategory).toLowerCase(),
    league: LEAGUES[prefix] ?? null,
    priceYes: Math.round(priceYes * 10_000) / 10_000,
    liquidity: num(m.liquidity_num) ?? num(m.liquidity) ?? 0,
    endMs: num(m.end_date),
    url: `${BASE}/en/event/${eventSlug}`,
  }
}

function isOpen(m: ProblyMarket, now: number): boolean {
  if (m.endMs != null && m.endMs <= now) return false
  // A market priced at a hard 0 or 1 is resolved in all but name.
  return m.priceYes > 0.005 && m.priceYes < 0.995
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchPage(path: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(BASE + path, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchProblyMarkets(): Promise<{ markets: ProblyMarket[]; errors: string[] }> {
  const bySlug = new Map<string, ProblyMarket>()
  const errors: string[] = []
  const now = Date.now()

  for (let p = 0; p < CATEGORY_PAGES.length; p++) {
    const path = CATEGORY_PAGES[p]
    try {
      const html = await fetchPage(path)
      for (const raw of extractRawMarkets(html)) {
        const m = normalizeMarket(raw, path)
        if (!m || !isOpen(m, now)) continue
        // The same market appears on several pages; keep the most liquid copy.
        const prev = bySlug.get(m.slug)
        if (!prev || m.liquidity > prev.liquidity) bySlug.set(m.slug, m)
      }
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`)
    }
    if (p < CATEGORY_PAGES.length - 1) await new Promise(r => setTimeout(r, PAGE_DELAY_MS))
  }
  return { markets: [...bySlug.values()], errors }
}

// ── Storage ─────────────────────────────────────────────────────────────────

export const PROBLY_MARKETS_DDL = `
  CREATE TABLE IF NOT EXISTS probly_markets (
    slug        TEXT PRIMARY KEY,
    event_slug  TEXT NOT NULL,
    question    TEXT NOT NULL,
    category    TEXT NOT NULL,
    league      TEXT,
    price_yes   REAL NOT NULL,
    liquidity   REAL NOT NULL DEFAULT 0,
    end_ms      INTEGER,
    url         TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  )`

/**
 * Replace the stored market list with a fresh fetch. A failed or implausibly
 * small fetch leaves the existing rows in place: when the scraper breaks we
 * want yesterday's markets, not an empty table that silently turns off every
 * market link and every Probly boost.
 */
export async function refreshProblyMarkets(): Promise<{ stored: number; kept: boolean; errors: string[]; resolved?: number }> {
  sqlite.exec(PROBLY_MARKETS_DDL)
  const { markets, errors } = await fetchProblyMarkets()

  const existing = (sqlite.prepare('SELECT COUNT(*) AS n FROM probly_markets').get() as { n: number }).n
  // Guard against a partial scrape wiping a good list: require the new batch to
  // be at least a third of what we already hold.
  if (markets.length === 0 || (existing > 0 && markets.length < existing / 3)) {
    return { stored: existing, kept: true, errors: [...errors, `kept ${existing} existing markets; fetch returned ${markets.length}`] }
  }

  const now = Date.now()
  const insert = sqlite.prepare(`
    INSERT INTO probly_markets (slug, event_slug, question, category, league, price_yes, liquidity, end_ms, url, fetched_at)
    VALUES (@slug, @eventSlug, @question, @category, @league, @priceYes, @liquidity, @endMs, @url, @fetchedAt)`)
  const replace = sqlite.transaction((rows: ProblyMarket[]) => {
    sqlite.prepare('DELETE FROM probly_markets').run()
    for (const m of rows) {
      insert.run({ ...m, fetchedAt: now })
    }
  })
  replace(markets)

  const aliases = await resolveMissingAliases(markets)
  resetProblyCache()
  return { stored: markets.length, kept: false, errors: [...errors, ...aliases.errors], resolved: aliases.resolved }
}

// ── Subjects ────────────────────────────────────────────────────────────────
//
// What a market is ABOUT, for matching against news. Sports questions follow a
// handful of fixed templates (measured on the live catalogue):
//
//   Will FC Bayern München win on 2026-09-18?          -> FC Bayern München
//   Spread: Brentford FC (-5.5)                         -> Brentford FC
//   Chelsea FC vs. Brentford FC                         -> Chelsea FC, Brentford FC
//   UFC 331: Alexandre Pantoja vs. Joshua Van (…)       -> Alexandre Pantoja, Joshua Van
//
// so the subject is lifted out deterministically. Non-sports questions are free
// text, so the whole question is the subject and the LLM picks its entities.

const SPORTS_PREFIX_RE =
  /^(?:(?:spread|total|moneyline|handicap|over\/under)\s*:\s*|ufc\s*\d+\s*:\s*|ufc fight night[^:]*:\s*|dana white'?s contender series\s*:\s*)/i

export function marketSubjects(question: string, category: string): string[] {
  if (category !== 'sports') return [question.trim()]
  let q = question.trim()
  q = q.replace(/^will\s+/i, '')
  q = q.replace(/\s+win on \d{4}-\d{2}-\d{2}\??$/i, '')
  q = q.replace(SPORTS_PREFIX_RE, '')
  // With the prefix gone, any remaining colon introduces a market-type suffix:
  // "Sevilla FC vs. FC Barcelona: O/U 3.5". Measured on the live catalogue it is
  // the only one (690 totals markets), and leaving it on turned "FC Barcelona:
  // O/U 3.5" into a separate subject for every line, so 691 of the first 1,113
  // alias resolutions were wasted on variants of subjects already resolved.
  q = q.replace(/\s*:\s.*$/, '')
  q = q.replace(/\s*\([^)]*\)\s*\??$/, '')   // "(-5.5)", "(Flyweight, Main Card)"
  q = q.replace(/\?$/, '')
  return q
    .split(/\s+vs\.?\s+/i)
    .map(x => x.trim())
    .filter(x => x.length >= 3 && !/^(?:over|under|draw|tie|yes|no)\b/i.test(x))
}

/** 5-minute "Up or Down" price markets are gone before any story could cite them. */
export function isMicroMarket(question: string): boolean {
  return /\bup or down\b/i.test(question)
}

// ── Alias resolution (LLM, batched, cached forever) ─────────────────────────
//
// A regex can't know that "FC Bayern München" appears in headlines as "Bayern
// Munich", or that "RCD Espanyol de Barcelona" is just "Espanyol". Haiku does.
// Subjects repeat across every fixture (a club plays weekly), so there are a few
// hundred unique subjects rather than ~1,900 markets, and each is resolved ONCE
// and cached permanently. Steady state is a handful of calls a week for newly
// listed clubs and fighters.

export const PROBLY_ALIASES_DDL = `
  CREATE TABLE IF NOT EXISTS probly_aliases (
    subject     TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    aliases     TEXT NOT NULL,
    resolved_at INTEGER NOT NULL
  )`

const ALIAS_BATCH = 40
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

const ALIAS_PROMPT = `You map prediction-market subjects to the exact phrases a news headline would contain if it were about them.

Two kinds of input:
- "subject": a sports team or athlete. Return the names headlines actually use: the common short name plus well-known variants. "FC Bayern München" -> ["bayern munich","bayern"]. "RCD Espanyol de Barcelona" -> ["espanyol"]. "Alexandre Pantoja" -> ["alexandre pantoja","pantoja"].
- "market": a full market question. Return 2-4 distinctive entities that together identify it; a headline must mention at least two of them to be about this market. "Will the Senate pass the Clarity Act by October 9?" -> ["senate","clarity act"].

Hard rules:
- Lowercase. Short phrases, no articles.
- NEVER return a word that is ambiguous on its own: "city", "united", "real", "inter", "athletic", "sporting", "fc", "club", "new york", "van", "de", or a bare city name that is also a different club or place. Use the full phrase instead ("man city", "real madrid").
- Do not invent: only names that genuinely refer to this subject.

Return ONLY JSON: {"results":[{"id":0,"aliases":["..."]}]}`

async function resolveBatch(items: { id: number; kind: 'subject' | 'market'; text: string }[]): Promise<Map<number, string[]>> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      temperature: 0,
      system: ALIAS_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(items.map(({ id, kind, text }) => ({ id, kind, text }))) }],
    }),
  })
  if (!res.ok) throw new Error(`alias resolution HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const data = await res.json() as { content?: Array<{ text?: string }> }
  const raw = (data.content?.[0]?.text ?? '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
  const parsed = JSON.parse(raw) as { results?: Array<{ id: number; aliases: unknown }> }
  const out = new Map<number, string[]>()
  for (const r of parsed.results ?? []) {
    if (!Array.isArray(r.aliases)) continue
    const clean = r.aliases
      .filter((a): a is string => typeof a === 'string')
      .map(a => a.toLowerCase().trim())
      .filter(a => a.length >= 3 && !AMBIGUOUS.has(a))
    out.set(r.id, [...new Set(clean)])
  }
  return out
}

// Enforced in code as well as in the prompt: a single ambiguous alias would link
// every "Man City" story to the wrong market.
const AMBIGUOUS = new Set([
  'city', 'united', 'real', 'inter', 'athletic', 'sporting', 'fc', 'club',
  'new york', 'van', 'de', 'la', 'san', 'st', 'saint', 'red', 'nacional',
  'racing', 'union', 'royal', 'dynamo', 'olympic', 'olympique',
])

/** Resolve any subjects not yet cached. Returns how many were newly resolved. */
export async function resolveMissingAliases(markets: ProblyMarket[]): Promise<{ resolved: number; errors: string[] }> {
  sqlite.exec(PROBLY_ALIASES_DDL)
  const known = new Set(
    (sqlite.prepare('SELECT subject FROM probly_aliases').all() as { subject: string }[]).map(r => r.subject),
  )
  const pending = new Map<string, 'subject' | 'market'>()
  for (const m of markets) {
    if (isMicroMarket(m.question)) continue
    const kind = m.category === 'sports' ? 'subject' : 'market'
    for (const s of marketSubjects(m.question, m.category)) {
      if (!known.has(s)) pending.set(s, kind)
    }
  }

  const insert = sqlite.prepare(
    'INSERT OR REPLACE INTO probly_aliases (subject, kind, aliases, resolved_at) VALUES (?, ?, ?, ?)')
  const entries = [...pending]
  const errors: string[] = []
  let resolved = 0
  for (let i = 0; i < entries.length; i += ALIAS_BATCH) {
    const batch = entries.slice(i, i + ALIAS_BATCH).map(([text, kind], id) => ({ id, kind, text }))
    try {
      const result = await resolveBatch(batch)
      const now = Date.now()
      for (const b of batch) {
        const aliases = result.get(b.id)
        // An empty result is still cached, so an unmatchable subject isn't re-asked
        // every hour; it simply never matches.
        insert.run(b.text, b.kind, JSON.stringify(aliases ?? []), now)
        resolved++
      }
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  return { resolved, errors }
}

// ── Matching ────────────────────────────────────────────────────────────────

const PHRASE_RE_CACHE = new Map<string, RegExp>()
function phraseMatch(haystack: string, phrase: string): boolean {
  let re = PHRASE_RE_CACHE.get(phrase)
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')
    PHRASE_RE_CACHE.set(phrase, re)
  }
  return re.test(haystack)
}

/** Fold accents so "München" in a headline matches "munchen". */
export function foldAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export interface ProblyMatch {
  question: string
  url: string
  priceYes: number
  liquidity: number
  league: string | null
  category: string
}

interface CachedMarket extends ProblyMatch {
  endMs: number | null
  // One entry per subject: a sports market matches if ANY subject's aliases hit;
  // a free-text market needs two of its entities.
  subjects: string[][]
  kind: 'subject' | 'market'
}

let cache: CachedMarket[] | null = null
let cacheAt = 0
const CACHE_TTL_MS = 10 * 60 * 1000

function loadMarkets(): CachedMarket[] {
  const now = Date.now()
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache
  try {
    sqlite.exec(PROBLY_MARKETS_DDL)
    sqlite.exec(PROBLY_ALIASES_DDL)
    const aliasOf = new Map<string, string[]>()
    for (const r of sqlite.prepare('SELECT subject, aliases FROM probly_aliases').all() as { subject: string; aliases: string }[]) {
      try { aliasOf.set(r.subject, (JSON.parse(r.aliases) as string[]).map(foldAccents)) } catch { /* skip */ }
    }
    const rows = sqlite.prepare(`
      SELECT question, url, price_yes, liquidity, league, category, end_ms FROM probly_markets`).all() as Array<{
        question: string; url: string; price_yes: number; liquidity: number
        league: string | null; category: string; end_ms: number | null
      }>
    cache = []
    for (const r of rows) {
      if (isMicroMarket(r.question)) continue
      const subjects = marketSubjects(r.question, r.category)
        .map(sub => aliasOf.get(sub) ?? [])
        .filter(a => a.length > 0)
      if (subjects.length === 0) continue
      cache.push({
        question: r.question, url: r.url, priceYes: r.price_yes, liquidity: r.liquidity,
        league: r.league, category: r.category, endMs: r.end_ms, subjects,
        kind: r.category === 'sports' ? 'subject' : 'market',
      })
    }
  } catch {
    cache = []
  }
  cacheAt = now
  return cache
}

/** Test hook: drop the in-process cache so the next lookup re-reads the table. */
export function resetProblyCache(): void { cache = null; cacheAt = 0 }

/**
 * The live Probly market a story is about, if any.
 *
 * Sports markets match on any one subject alias, but ONLY for a story the scorer
 * already classed as sports — otherwise "Monaco" in a royal-family story, or
 * "Brentford" in a local planning story, would link to a football market.
 * Free-text markets need two of their entities, because one shared name (every
 * "Trump" story) is not enough to say a story is about "Will Trump post 80-99
 * Truth Social posts". When several match, the most liquid open market wins.
 */
export function problyMarketFor(headline: string, summary = '', storyCategory: string | null = null): ProblyMatch | null {
  const markets = loadMarkets()
  if (markets.length === 0) return null
  const haystack = foldAccents(`${headline} ${summary}`.toLowerCase())
  const now = Date.now()
  const isSportsStory = storyCategory === 'sports'

  let best: CachedMarket | null = null
  for (const m of markets) {
    if (m.endMs != null && m.endMs <= now) continue
    let hit = false
    if (m.kind === 'subject') {
      if (!isSportsStory) continue
      hit = m.subjects.some(aliases => aliases.some(a => phraseMatch(haystack, a)))
    } else {
      const entities = m.subjects.flat()
      const need = Math.min(2, entities.length)
      hit = entities.filter(e => phraseMatch(haystack, e)).length >= need
    }
    if (!hit) continue
    if (!best || m.liquidity > best.liquidity) best = m
  }
  if (!best) return null
  const { question, url, priceYes, liquidity, league, category } = best
  return { question, url, priceYes, liquidity, league, category }
}
