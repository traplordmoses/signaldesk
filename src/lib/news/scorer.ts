const TIER1 = [
  'fed rate', 'fomc', 'cpi report', 'jobs report', 'election result',
  'rate hike', 'rate cut', 'war declared', 'coup', 'nuclear', 'sanctions',
  'default', 'resign', 'assassination', 'rate decision', 'indicted',
  'military', 'airstrike', 'invasion', 'fomc statement',
  'known exploited vulnerability', 'kev catalog', 'emergency alert',
  'tornado warning', 'hurricane warning', 'major earthquake',
]

const TIER2 = [
  'interest rate', 'inflation', 'gdp', 'earnings', 'acquisition', 'ipo',
  'championship', 'trade deal', 'fda approval', 'bitcoin etf', 'sec ruling',
  'arrested', 'fired', 'hired', 'merger', 'bankruptcy', 'tariff',
  'material definitive agreement', 'results of operations',
  'regulation fd disclosure', 'guidance', 'recall', 'class i',
  'class ii', 'cve', 'vulnerability', 'exploit', 'data breach',
  'cyberattack', 'severe thunderstorm warning', 'flash flood warning',
  'earthquake',
]

const TIER3 = [
  'poll', 'survey', 'forecast', 'record high', 'record low',
  'quarterly results', 'announced', 'confirmed', 'signed', 'reportedly',
]

// Priority companies + indices the audience cares about during earnings
// season and big macro days. Headlines mentioning any of these get a +1.5
// score bump on top of the base scoring. Both common names ("apple",
// "microsoft") and tickers ("aapl", "msft") are listed because news
// headlines mix the two interchangeably. Keep the list tight — adding
// the entire S&P 500 here would dilute the signal.
const PRIORITY_TICKERS = [
  // mag7
  'apple', 'aapl',
  'microsoft', 'msft',
  'google', 'alphabet', 'googl', 'goog',
  'amazon', 'amzn',
  'meta', 'facebook',
  'tesla', 'tsla',
  'nvidia', 'nvda',

  // big tech beyond mag7
  'amd',
  'oracle', 'orcl',
  'salesforce',
  'netflix', 'nflx',
  'intel', 'intc',
  'palantir', 'pltr',
  'broadcom', 'avgo',

  // big banks
  'jpmorgan', 'jpm',
  'goldman sachs', 'goldman',
  'bank of america',
  'wells fargo',
  'morgan stanley',
  'citigroup', 'citi',

  // defense / oil / industrials
  'lockheed martin',
  'raytheon', 'rtx',
  'boeing', 'ba',
  'exxon', 'xom',
  'chevron', 'cvx',

  // indices
  's&p 500', 'sp500', 'nasdaq', 'dow jones', 'russell 2000',

  // crypto majors
  'bitcoin', 'btc',
  'ethereum', 'eth',
  'solana', 'sol',
]

// TRAGEDY — auto-skip from generation. Keep this list narrow and unambiguous:
// the bot must NEVER auto-write competing content during an active tragedy.
// Keywords picked so they almost always indicate literal violence or loss of
// life in news headlines (false positives like "killed it on stage" are
// vanishingly rare in actual breaking-news writing).
const TRAGEDY = [
  'killed', 'casualties', 'victims', 'fatalities',
  'shooting', 'bombing',
  'terror', 'terrorist',
  'hostage', 'massacre',
  'murder', 'murdered',
]

// LOCAL_CRIME — routine local crime stories (Hong Kong burglaries, drug busts,
// muggings) leaked through to cards in the May 5 review because the markets-
// boost + source-weight + recency stack pushed them past the auto-generate
// threshold. These are not prediction-market relevant. Each match deducts a
// flat penalty from the final score so a single LOCAL_CRIME hit drops a
// borderline story below the threshold without killing legitimate big-crime
// stories that ALSO have TIER1 hits (e.g. "DOJ indicts cartel" still scores
// in the 4-5 range and won't auto-generate, which is the right outcome — that
// kind of story should come through manual review or via the indictment angle).
//
// Kept narrow on purpose: 'shooting' / 'bombing' / 'casualties' stay in the
// TRAGEDY auto-skip list above. LOCAL_CRIME covers property crime + small-
// scale drug enforcement only. Solo 'heroin' / 'cocaine' are excluded because
// they appear in legitimate trafficking-policy and overdose-epidemic stories.
const LOCAL_CRIME = [
  'burglary', 'burglar',
  'robbery',
  'mugging', 'mugged',
  'carjacking',
  'drug bust', 'drug raid', 'narcotics raid',
  'heroin bust', 'cocaine bust', 'cocaine seizure',
  'arson',
  'vandalism', 'vandalized',
  'shoplifting',
  'pickpocket',
  'home invasion',
]
const LOCAL_CRIME_PENALTY = 3

// HIGH_STAKES — show ⚠️ warning on the review card but still generate. These
// are legitimate prediction-market-relevant breaking stories (Iran nuclear
// talks, Trump indictments, DOJ moves, SEC charges, election results) that
// the bot exists precisely to surface. Previously they were auto-skipped,
// which meant the King Charles "nuclear weapon ban" cluster — a textbook
// high-stakes geopolitical story — got blocked by the same "nuclear"
// keyword that was simultaneously boosting it to the top of the score list.
// Reviewer judgement is the right gate here, not a hard block.
const HIGH_STAKES = [
  // legal / DOJ / financial enforcement
  'doj', 'sec charges', 'criminal', 'indicted', 'arrested',
  'lawsuit', 'legal', 'conviction', 'guilty verdict',

  // geopolitical high-stakes (newsworthy, rarely tragic in framing)
  'nuclear', 'sanctions', 'assassination', 'attack',

  // sensitive but routine in news: prefer human review over auto-skip
  'death',

  // cyber / public-health alerts: relevant but should still be reviewed
  'data breach', 'cyberattack', 'kev catalog', 'class i recall',

  // political heat (kept from the old MEDIUM_RISK list)
  'political', 'election', 'controversy', 'scandal', 'protest',
  'conflict',
]

// Word-boundary keyword matching. `text.includes('doj')` would hit any string
// containing the substring "doj" — including unrelated words. This builds a regex
// per keyword that requires non-word chars (or string boundaries) on either side,
// while still allowing multi-word keywords like "rate cut" to match across spaces.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const WORD_RE_CACHE = new Map<string, RegExp>()
function wordBoundaryMatch(text: string, kw: string): boolean {
  let re = WORD_RE_CACHE.get(kw)
  if (!re) {
    re = new RegExp(`(?:^|\\W)${escapeRegex(kw)}(?:$|\\W)`, 'i')
    WORD_RE_CACHE.set(kw, re)
  }
  return re.test(text)
}

export function scoreItem(title: string, summary: string, weight: number, publishedAt: number): number {
  const text = (title + ' ' + (summary ?? '')).toLowerCase()
  let score = 0

  for (const kw of TIER1) {
    if (wordBoundaryMatch(text, kw)) score += 4
  }
  for (const kw of TIER2) {
    if (wordBoundaryMatch(text, kw)) score += 2
  }
  for (const kw of TIER3) {
    if (wordBoundaryMatch(text, kw)) score += 1
  }

  // Source weight bonus
  if (weight >= 9) score += 1.0
  else if (weight >= 7) score += 0.5

  // Priority-ticker bonus — headlines mentioning a mag7 company, big bank,
  // major index, or BTC/ETH get +1.5. Caps at one bonus per article (we
  // don't want a "Apple beats Microsoft on iPhone sales" double-counting).
  for (const ticker of PRIORITY_TICKERS) {
    if (wordBoundaryMatch(text, ticker)) {
      score += 1.5
      break
    }
  }

  // Recency bonus
  const ageMs = Date.now() - publishedAt
  const ageHours = ageMs / 1000 / 60 / 60
  if (ageHours < 1) score += 1.0
  else if (ageHours < 3) score += 0.5

  // Market-relevance bonus — +0..3 based on whether the headline matches an
  // entity from any active high-volume Polymarket / Kalshi market. Pulled
  // from a 5-min in-memory cache built from the `market_topics` table.
  // Lazy import keeps this file from circular-importing the markets module.
  // Fail-safe: if the markets module can't load (e.g. during boot before
  // the table exists), return 0 and continue.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { relevanceBoost } = require('@/lib/markets') as typeof import('@/lib/markets')
    score += relevanceBoost(title, summary)
  } catch {
    // markets module not available — no boost, continue
  }

  // Local-crime penalty — applied AFTER all bonuses so it docks the final
  // composite score. Capped at one penalty per article (a single mention is
  // enough to flag the story type; we don't compound on "burglary suspect
  // arrested in second burglary" double hits).
  for (const kw of LOCAL_CRIME) {
    if (wordBoundaryMatch(text, kw)) {
      score -= LOCAL_CRIME_PENALTY
      break
    }
  }

  return Math.min(10, Math.max(0, score))
}

export function detectRisk(text: string): { level: 'low' | 'medium' | 'high'; reasons: string[] } {
  const lower = text.toLowerCase()
  const reasons: string[] = []

  // Tier 1: tragedy → auto-skip
  for (const kw of TRAGEDY) {
    if (wordBoundaryMatch(lower, kw)) reasons.push(kw)
  }
  if (reasons.length > 0) return { level: 'high', reasons }

  // Tier 2: high-stakes news → warn-only, still generates
  for (const kw of HIGH_STAKES) {
    if (wordBoundaryMatch(lower, kw)) reasons.push(kw)
  }
  if (reasons.length > 0) return { level: 'medium', reasons }

  return { level: 'low', reasons: [] }
}

export function getTier1And2Keywords(): string[] {
  return [...TIER1, ...TIER2]
}
