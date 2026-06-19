/**
 * Backtest: old scorer vs. redesigned scorer over the bot's real news history.
 *
 * Run against a THROWAWAY copy of the DB so nothing here touches dev/prod state:
 *
 *   cp data/signaldesk.db /tmp/signaldesk-backtest.db
 *   DB_PATH=/tmp/signaldesk-backtest.db npx tsx scripts/backtest-scoring.ts
 *
 * It (1) seeds market_topics with a snapshot of real Polymarket/Kalshi markets
 * (captured 2026-06-19) so the market-fit spine actually fires, (2) re-scores
 * every news_item under a frozen copy of the OLD scorer and the NEW scorer
 * (both using the same seeded markets), and (3) prints the before/after flip +
 * a threshold recommendation.
 */
import { sqlite } from '../src/lib/db'
import { scoreItem } from '../src/lib/news/scorer'
import { marketFit } from '../src/lib/markets'

// ── 1. Seed market_topics with a real market snapshot ───────────────────────
interface Seed { id: string; question: string; volume: number; category: string; entities: string[] }
const SEEDS: Seed[] = [
  { id: 'seed:worldcup', question: 'World Cup Winner', volume: 5_000_000, category: 'sports', entities: ['world cup', 'fifa', 'soccer', 'football'] },
  { id: 'seed:ballondor', question: "Ballon d'Or Winner 2026", volume: 4_200_000, category: 'sports', entities: ["ballon d'or", 'haaland', 'mbappe', 'messi'] },
  { id: 'seed:btc2026', question: 'What price will Bitcoin hit in 2026?', volume: 6_800_000, category: 'crypto', entities: ['bitcoin', 'btc'] },
  { id: 'seed:eth', question: 'What price will Ethereum hit in June?', volume: 4_500_000, category: 'crypto', entities: ['ethereum', 'eth'] },
  { id: 'seed:sol', question: 'What price will Solana hit in June?', volume: 1_500_000, category: 'crypto', entities: ['solana'] },
  { id: 'seed:xrp', question: 'What price will XRP hit in June?', volume: 883_000, category: 'crypto', entities: ['xrp', 'ripple'] },
  { id: 'seed:kraken', question: 'Kraken IPO by ___?', volume: 1_200_000, category: 'crypto', entities: ['kraken', 'exchange ipo', 'crypto listing'] },
  { id: 'seed:openai-ipo', question: 'OpenAI IPO Closing Market Cap', volume: 2_000_000, category: 'other', entities: ['openai', 'ipo', 'sam altman'] },
  { id: 'seed:spacex', question: "Will SpaceX's valuation hit ___ by June 30?", volume: 650_000, category: 'other', entities: ['spacex', 'elon musk', 'valuation'] },
  { id: 'seed:ai-model', question: 'Which company has best AI model end of June?', volume: 15_900_000, category: 'other', entities: ['ai model', 'anthropic', 'openai', 'deepseek', 'xai', 'claude', 'gpt'] },
  { id: 'seed:gpt56', question: 'When will GPT-5.6 be released?', volume: 1_000_000, category: 'other', entities: ['gpt-5', 'openai', 'chatgpt'] },
  { id: 'seed:fable5', question: 'Claude Fable 5 restored for US customers by ___?', volume: 1_000_000, category: 'other', entities: ['claude', 'anthropic'] },
  { id: 'seed:fed-sep', question: 'Fed Decision in September?', volume: 532_000, category: 'economics', entities: ['fed', 'federal reserve', 'rate cut', 'fomc', 'rate decision'] },
  { id: 'seed:fed-cuts', question: 'How many Fed rate cuts in 2026?', volume: 2_500_000, category: 'economics', entities: ['fed', 'rate cut', 'interest rate', 'fomc'] },
  { id: 'seed:gold', question: 'What will Gold hit by end of June?', volume: 6_500_000, category: 'economics', entities: ['gold', 'xauusd', 'commodities'] },
  { id: 'seed:oil', question: 'Will Crude Oil hit ___ by end of June?', volume: 30_400_000, category: 'economics', entities: ['crude oil', 'oil price', 'wti'] },
  { id: 'seed:spx', question: 'What will S&P 500 hit in June 2026?', volume: 447_000, category: 'economics', entities: ['s&p 500', 'spx'] },
  { id: 'seed:largest-co', question: 'Largest Company end of June?', volume: 22_900_000, category: 'economics', entities: ['nvidia', 'apple', 'market cap'] },
  { id: 'seed:toystory', question: '"Toy Story 5" Opening Weekend Box Office', volume: 220_000, category: 'culture', entities: ['toy story', 'box office', 'pixar'] },
  { id: 'seed:movie2026', question: 'Highest grossing movie in 2026?', volume: 12_300_000, category: 'culture', entities: ['box office', 'highest grossing', 'movie'] },
  { id: 'seed:mrbeast', question: '# of views of MrBeast video day 6?', volume: 100_000, category: 'culture', entities: ['mrbeast'] },
  { id: 'seed:hits', question: 'Which artists will have #1 hits in the US in June?', volume: 158_000, category: 'culture', entities: ['bad bunny', 'noah kahan', 'billboard', 'number one'] },
  { id: 'seed:taylor', question: 'Taylor Swift pregnant in 2026?', volume: 3_000_000, category: 'culture', entities: ['taylor swift'] },
  { id: 'seed:cagov', question: 'California Governor Election Winner', volume: 39_400_000, category: 'politics', entities: ['california governor', 'padilla', 'caruso'] },
  { id: 'seed:ny17', question: 'NY-17 Democratic Primary Winner', volume: 137_000, category: 'politics', entities: ['ny-17', 'democratic primary'] },
  { id: 'seed:trump-out', question: 'Trump out as President by June 30?', volume: 8_100_000, category: 'politics', entities: ['trump'] },
  { id: 'seed:iran-enrich', question: 'Iran agrees to end enrichment of uranium by December 31?', volume: 16_200_000, category: 'politics', entities: ['iran', 'uranium', 'enrichment'] },
  { id: 'seed:ru-ua', question: 'Russia x Ukraine ceasefire agreement by ___?', volume: 4_500_000, category: 'politics', entities: ['russia', 'ukraine', 'ceasefire'] },
  { id: 'seed:hormuz', question: 'Strait of Hormuz traffic returns to normal by December 31?', volume: 2_400_000, category: 'politics', entities: ['strait of hormuz', 'hormuz', 'shipping'] },
  { id: 'seed:israel-leb', question: 'Israel withdraws from Lebanon by ___?', volume: 4_200_000, category: 'politics', entities: ['israel', 'lebanon'] },
  { id: 'seed:elon-tweets', question: 'Elon Musk # tweets in June 2026?', volume: 1_800_000, category: 'other', entities: ['elon musk', 'tweets'] },
  { id: 'seed:temp-tokyo', question: 'Highest temperature in Tokyo on June 20?', volume: 50_000, category: 'science', entities: ['tokyo', 'temperature'] },
  { id: 'seed:quakes', question: 'How many 6.5 or above earthquakes June 15-21?', volume: 50_000, category: 'science', entities: ['earthquake', 'magnitude'] },
]

function seedMarkets() {
  const now = Date.now()
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO market_topics
       (id, source, market_id, question, volume_24h, topic, entities, category, extracted_at, last_seen_at)
     VALUES (?, 'polymarket', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = sqlite.transaction(() => {
    for (const s of SEEDS) {
      stmt.run(s.id, s.id, s.question, s.volume, s.question, JSON.stringify(s.entities), s.category, now, now)
    }
  })
  tx()
}

// ── 2. Frozen copy of the OLD scorer (pre-redesign) ─────────────────────────
const OLD_TIER1 = ['fed rate', 'fomc', 'cpi report', 'jobs report', 'election result', 'rate hike', 'rate cut', 'war declared', 'coup', 'nuclear', 'sanctions', 'default', 'resign', 'assassination', 'rate decision', 'indicted', 'military', 'airstrike', 'invasion', 'fomc statement', 'known exploited vulnerability', 'kev catalog', 'emergency alert', 'tornado warning', 'hurricane warning', 'major earthquake']
const OLD_TIER2 = ['interest rate', 'inflation', 'gdp', 'earnings', 'acquisition', 'ipo', 'championship', 'trade deal', 'fda approval', 'bitcoin etf', 'sec ruling', 'arrested', 'fired', 'hired', 'merger', 'bankruptcy', 'tariff', 'material definitive agreement', 'results of operations', 'regulation fd disclosure', 'guidance', 'recall', 'class i', 'class ii', 'cve', 'vulnerability', 'exploit', 'data breach', 'cyberattack', 'severe thunderstorm warning', 'flash flood warning', 'earthquake']
const OLD_TIER3 = ['poll', 'survey', 'forecast', 'record high', 'record low', 'quarterly results', 'announced', 'confirmed', 'signed', 'reportedly']
const OLD_PRIORITY = ['apple', 'aapl', 'microsoft', 'msft', 'google', 'alphabet', 'googl', 'goog', 'amazon', 'amzn', 'meta', 'facebook', 'tesla', 'tsla', 'nvidia', 'nvda', 'amd', 'oracle', 'orcl', 'salesforce', 'netflix', 'nflx', 'intel', 'intc', 'palantir', 'pltr', 'broadcom', 'avgo', 'jpmorgan', 'jpm', 'goldman sachs', 'goldman', 'bank of america', 'wells fargo', 'morgan stanley', 'citigroup', 'citi', 'lockheed martin', 'raytheon', 'rtx', 'boeing', 'ba', 'exxon', 'xom', 'chevron', 'cvx', 's&p 500', 'sp500', 'nasdaq', 'dow jones', 'russell 2000', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol']
const OLD_LOCAL_CRIME = ['burglary', 'burglar', 'robbery', 'mugging', 'mugged', 'carjacking', 'drug bust', 'drug raid', 'narcotics raid', 'heroin bust', 'cocaine bust', 'cocaine seizure', 'arson', 'vandalism', 'vandalized', 'shoplifting', 'pickpocket', 'home invasion']

const RE = new Map<string, RegExp>()
function wb(text: string, kw: string): boolean {
  let re = RE.get(kw)
  if (!re) { re = new RegExp(`(?:^|\\W)${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i'); RE.set(kw, re) }
  return re.test(text)
}

// OLD market boost: 0.5 * log10(maxVolume), cap 3 — replicated over the same
// seeded markets so the comparison isolates the scoring-logic change.
let oldEntityMap: Map<string, number> | null = null
function buildOldEntityMap(): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of SEEDS) for (const e of s.entities) {
    const k = e.toLowerCase().trim()
    if (k.length < 3) continue
    if ((m.get(k) ?? 0) < s.volume) m.set(k, s.volume)
  }
  return m
}
function oldBoost(title: string, summary: string): number {
  if (!oldEntityMap) oldEntityMap = buildOldEntityMap()
  const hay = `${title} ${summary}`.toLowerCase()
  let max = 0
  for (const [e, v] of oldEntityMap) if (hay.includes(e) && v > max) max = v
  if (max <= 0) return 0
  return Math.min(3, Math.max(0, 0.5 * Math.log10(max)))
}

function oldScoreItem(title: string, summary: string, weight: number, publishedAt: number): number {
  const text = (title + ' ' + (summary ?? '')).toLowerCase()
  let score = 0, hasTier1 = false
  for (const kw of OLD_TIER1) if (wb(text, kw)) { score += 4; hasTier1 = true }
  for (const kw of OLD_TIER2) if (wb(text, kw)) score += 2
  for (const kw of OLD_TIER3) if (wb(text, kw)) score += 1
  if (weight >= 9) score += 1; else if (weight >= 7) score += 0.5
  for (const t of OLD_PRIORITY) if (wb(text, t)) { score += 1.5; break }
  const ageH = (Date.now() - publishedAt) / 3_600_000
  if (ageH < 1) score += 1; else if (ageH < 3) score += 0.5
  score += oldBoost(title, summary)
  for (const kw of OLD_LOCAL_CRIME) if (wb(text, kw)) { score -= 3; break }
  return Math.min(hasTier1 ? 10 : 8, Math.max(0, score))
}

// ── 3. Run the backtest ─────────────────────────────────────────────────────
interface Row { title: string; summary: string; publishedAt: number; weight: number }
function fmtVol(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v}`
}
function pad(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n) }

function main() {
  seedMarkets()
  oldEntityMap = buildOldEntityMap()

  const rows = sqlite.prepare<[], Row & { summary: string | null }>(
    `SELECT ni.title AS title, COALESCE(ni.summary,'') AS summary, ni.published_at AS publishedAt,
            COALESCE(ns.weight, 5) AS weight
     FROM news_items ni LEFT JOIN news_sources ns ON ns.id = ni.source_id`
  ).all()

  const scored = rows.map(r => {
    const summary = r.summary ?? ''
    const oldS = oldScoreItem(r.title, summary, r.weight, r.publishedAt)
    const newS = scoreItem(r.title, summary, r.weight, r.publishedAt)
    const fit = marketFit(r.title, summary)
    return { title: r.title, oldS, newS, market: fit.matched, cat: fit.category, vol: fit.maxVolume }
  })

  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`)
  console.log(`║  SCORING BACKTEST — ${scored.length} real news items · ${SEEDS.length} seeded markets`)
  console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`)

  // Threshold distribution
  console.log(`\n── How many items clear each threshold (old → new) ──`)
  for (const t of [5, 5.5, 6, 6.5, 7]) {
    const o = scored.filter(s => s.oldS >= t).length
    const n = scored.filter(s => s.newS >= t).length
    console.log(`  ≥ ${t.toFixed(1)}   old ${String(o).padStart(4)}   new ${String(n).padStart(4)}`)
  }
  const marketShareNew = scored.filter(s => s.newS >= 6 && s.market).length
  const passNew6 = scored.filter(s => s.newS >= 6).length
  console.log(`  of new ≥6.0: ${marketShareNew}/${passNew6} map to a live market (${passNew6 ? Math.round(100 * marketShareNew / passNew6) : 0}%)`)

  // Top 15 by OLD — the doom list, and where it lands now
  console.log(`\n── TOP 15 BY OLD SCORE (the doom list) → new score ──`)
  console.log(`  ${pad('headline', 62)} old →  new`)
  for (const s of [...scored].sort((a, b) => b.oldS - a.oldS).slice(0, 15)) {
    const arrow = s.newS < s.oldS ? '↓' : s.newS > s.oldS ? '↑' : '='
    console.log(`  ${pad(s.title, 62)} ${s.oldS.toFixed(1).padStart(4)} → ${s.newS.toFixed(1).padStart(4)} ${arrow}`)
  }

  // Top 20 by NEW — the optimistic list that now rises
  console.log(`\n── TOP 20 BY NEW SCORE (what the redesign surfaces) ──`)
  console.log(`  ${pad('headline', 56)}  new ← old  market`)
  for (const s of [...scored].sort((a, b) => b.newS - a.newS).slice(0, 20)) {
    const mk = s.market ? `${s.cat ?? '?'} ${fmtVol(s.vol)}` : '—'
    console.log(`  ${pad(s.title, 56)} ${s.newS.toFixed(1).padStart(4)} ← ${s.oldS.toFixed(1).padStart(4)}  ${mk}`)
  }

  // ── 4. Labeled fixtures incl. real historical bot drafts ──────────────────
  console.log(`\n── LABELED FIXTURES (old → new) ──`)
  const fixtures: Array<[string, string]> = [
    ['DOOM (real old draft)', 'Man charged in attempted assassination of Trump at Pennsylvania rally'],
    ['DOOM (real old draft)', 'The U.S. and Israel are at war with Iran’s proxies'],
    ['GORE', 'Dozens killed as airstrike hits Sumy, casualties mount'],
    ['REFRAMED GEO', 'Iran agrees to end uranium enrichment by year-end, market sees 67%'],
    ['SPORTS', 'World Cup kicks off this week: Mexico vs South Africa in the opener'],
    ['CRYPTO', 'Bitcoin surges to a record all-time high ahead of the Fed decision'],
    ['TECH/IPO', 'OpenAI set to go public — IPO could close above $500B this month'],
    ['CULTURE', 'Toy Story 5 opens this weekend, on track for a record box office'],
    ['MACRO', 'Fed expected to deliver a rate cut at the September decision'],
    ['LOCAL CRIME', 'Hong Kong police bust burglary ring in Kowloon'],
  ]
  const ts = Date.now() - 60 * 60 * 1000
  for (const [label, h] of fixtures) {
    const o = oldScoreItem(h, '', 9, ts)
    const n = scoreItem(h, '', 9, ts)
    const fit = marketFit(h, '')
    const mk = fit.matched ? `${fit.category} ${fmtVol(fit.maxVolume)}` : '—'
    console.log(`  ${pad(label, 22)} ${o.toFixed(1).padStart(4)} → ${n.toFixed(1).padStart(4)}  [${mk}]  ${pad(h, 58)}`)
  }
  console.log('')
}

main()
