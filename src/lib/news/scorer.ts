const TIER1 = [
  'fed rate', 'fomc', 'cpi report', 'jobs report', 'election result',
  'rate hike', 'rate cut', 'war declared', 'coup', 'nuclear', 'sanctions',
  'default', 'resign', 'assassination', 'rate decision', 'indicted',
  'military', 'airstrike', 'invasion',
]

const TIER2 = [
  'interest rate', 'inflation', 'gdp', 'earnings', 'acquisition', 'ipo',
  'championship', 'trade deal', 'fda approval', 'bitcoin etf', 'sec ruling',
  'arrested', 'fired', 'hired', 'merger', 'bankruptcy', 'tariff',
]

const TIER3 = [
  'poll', 'survey', 'forecast', 'record high', 'record low',
  'quarterly results', 'announced', 'confirmed', 'signed', 'reportedly',
]

const HIGH_RISK = [
  'death', 'killed', 'casualties', 'shooting', 'bombing', 'nuclear',
  'assassination', 'sec charges', 'doj', 'criminal', 'attack',
]

const MEDIUM_RISK = [
  'political', 'election', 'lawsuit', 'controversy', 'scandal', 'protest',
  'conflict', 'legal', 'reportedly',
]

export function scoreItem(title: string, summary: string, weight: number, publishedAt: number): number {
  const text = (title + ' ' + (summary ?? '')).toLowerCase()
  let score = 0

  for (const kw of TIER1) {
    if (text.includes(kw)) score += 4
  }
  for (const kw of TIER2) {
    if (text.includes(kw)) score += 2
  }
  for (const kw of TIER3) {
    if (text.includes(kw)) score += 1
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

  for (const kw of HIGH_RISK) {
    if (lower.includes(kw)) reasons.push(kw)
  }
  if (reasons.length > 0) return { level: 'high', reasons }

  for (const kw of MEDIUM_RISK) {
    if (lower.includes(kw)) reasons.push(kw)
  }
  if (reasons.length > 0) return { level: 'medium', reasons }

  return { level: 'low', reasons: [] }
}

export function getTier1And2Keywords(): string[] {
  return [...TIER1, ...TIER2]
}
