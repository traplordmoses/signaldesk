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
]

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

  // Recency bonus
  const ageMs = Date.now() - publishedAt
  const ageHours = ageMs / 1000 / 60 / 60
  if (ageHours < 1) score += 1.0
  else if (ageHours < 3) score += 0.5

  return Math.min(10, score)
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
