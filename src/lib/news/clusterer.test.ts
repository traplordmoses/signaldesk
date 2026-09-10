/**
 * Coverage for the cluster-merge eligibility check. The bug it addresses:
 * five separate cards for the same Trump-EU tariff event over an hour because
 * each cron tick saw new items in isolation. The merge pass requires ≥2 shared
 * TIER1/TIER2 keywords with an existing same-category cluster created in the
 * last 60 minutes.
 */
import { describe, it, expect } from 'vitest'
import { shouldMergeIntoExisting, topicalTokens, keywordOverlap, sameStory, properNouns, buildDocFrequency, distinctivenessCutoff } from './clusterer'
import { getTier1And2Keywords } from './scorer'

function kwSet(text: string): Set<string> {
  const lower = text.toLowerCase()
  const out = new Set<string>()
  for (const kw of getTier1And2Keywords()) {
    const re = new RegExp(`(?:^|\\W)${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i')
    if (re.test(lower)) out.add(kw)
  }
  return out
}

describe('shouldMergeIntoExisting', () => {
  it('merges when candidate and existing share 2+ TIER1/TIER2 keywords', () => {
    const candidate = kwSet('Trump tariff threat sparks fresh EU sanctions debate')
    const existingText = 'Brussels weighs sanctions response after Trump tariff escalation'
    expect(shouldMergeIntoExisting(candidate, existingText)).toBe(true)
  })

  it('does not merge when only one keyword overlaps', () => {
    const candidate = kwSet('Goldman beats earnings expectations')
    const existingText = 'Tornado warning issued for central Texas — earnings unaffected'
    // both contain "earnings" but nothing else — single keyword shouldn't trigger merge
    expect(shouldMergeIntoExisting(candidate, existingText)).toBe(false)
  })

  it('does not merge when keyword sets are entirely disjoint', () => {
    const candidate = kwSet('Bitcoin ETF inflows hit record')
    const existingText = 'FDA approval expected for new diabetes drug this week'
    expect(shouldMergeIntoExisting(candidate, existingText)).toBe(false)
  })

  it('merges when existing cluster summary text mentions the same entities', () => {
    const candidate = kwSet('CPI report comes in hotter than expected — Fed rate cut hopes fading')
    const existingText = 'Fed rate decision next week. CPI report due Tuesday will set the tone for the FOMC statement.'
    expect(shouldMergeIntoExisting(candidate, existingText)).toBe(true)
  })

  it('does not merge a single-keyword candidate even against a rich existing cluster', () => {
    const candidate = kwSet('CPI report comes in hotter than expected')
    const existingText = 'Fed rate decision next week. CPI report due Tuesday will set the tone for the FOMC statement.'
    // Single shared keyword (cpi report) is below the 2-keyword threshold —
    // intentional: a one-word match is too noisy to drive a merge.
    expect(shouldMergeIntoExisting(candidate, existingText)).toBe(false)
  })

  it('handles empty candidate keyword set without crashing', () => {
    expect(shouldMergeIntoExisting(new Set(), 'Trump tariff escalates')).toBe(false)
  })
})

describe('topicalTokens dedup — same-entity twins caught, distinct stories spared', () => {
  // Regression: two "Messi broke the WC scoring record" cards posted 25 min apart
  // because the scoring-vocab dedup shared <2 keywords. topicalTokens compares
  // real content words; the scheduler flags a dup at shared≥4 AND coef≥0.5.
  const isDup = (a: string, b: string) => {
    const A = topicalTokens(a), B = topicalTokens(b)
    const shared = keywordOverlap(A, B)
    return shared >= 4 && shared / Math.min(A.size, B.size) >= 0.5
  }
  it('flags two phrasings of the same Messi record story', () => {
    expect(isDup(
      'Lionel Messi just broke the World Cup all-time scoring record as Argentina advanced',
      'Lionel Messi broke the World Cup all-time scoring record with his 17th goal netting',
    )).toBe(true)
  })
  it('does NOT flag two different World Cup matches', () => {
    expect(isDup(
      'Portugal vs Uzbekistan kicks off Tuesday in the 2026 World Cup as Ronaldo takes the pitch',
      'Argentina vs Austria tips off in the 2026 World Cup group stage as Messi odds front',
    )).toBe(false)
  })
  it('does NOT flag unrelated same-category stories', () => {
    expect(isDup(
      'Lionel Messi broke the World Cup all-time scoring record',
      'Dallas Mavericks hiring Michigan coach Dusty May from college ranks',
    )).toBe(false)
  })
})

/**
 * Same-story detection (added 2026-09-10).
 *
 * The bug: one story covered by many outlets produced one card per outlet. The
 * Anthropic bioweapons story generated EIGHT separate clusters in two hours,
 * because coverage of it shares exactly one curated keyword ('anthropic').
 *
 * The headlines below are verbatim from production. The traps are the reason
 * plain token overlap isn't enough: "same template, different entities" shares
 * as many tokens as "same event, different wording".
 */
describe('sameStory — one event, many outlets', () => {
  const BIO = [
    'Anthropic says scientists used AI for possible biological weapons development',
    'Anthropic sounds alarm on AI models being misused to develop biological weapons',
    'Anthropic says scientists used its AI for research that could aid biological weapons development',
    'Anthropic says It disrupted attempts to misuse AI for biological weapons research',
    'Anthropic blocks accounts of several scientists after detecting research with potential to develop biological weapons',
  ]
  // Ambient corpus so 'anthropic' is common and 'biological' is distinctive,
  // which is the situation during a wave of AI coverage.
  // Sized like a real fetch batch (~130 items). Distinctiveness is a RATIO of
  // batch size, so a toy corpus makes 'biological' itself look common and the
  // test measures nothing.
  const CORPUS = [
    ...BIO,
    ...Array.from({ length: 23 }, (_, i) => `Anthropic announces unrelated business item number ${i} about hiring`),
    ...Array.from({ length: 100 }, (_, i) => `Unrelated market story number ${i} covering shipping and freight rates`),
    'Scoop: Anthropic whistleblower gave up his equity to leave the company',
    'Anthropic Drops Stark AI Forecast for U.S. Economy',
    'Emil Michael stands by Anthropic blacklist',
  ]
  const df = buildDocFrequency(CORPUS)
  const dfMax = distinctivenessCutoff(CORPUS.length)
  const same = (a: string, b: string) => sameStory(a, b, df, dfMax)

  it('merges coverage of the same event across outlets', () => {
    const pairs = BIO.flatMap((a, i) => BIO.slice(i + 1).map(b => [a, b] as const))
    const merged = pairs.filter(([a, b]) => same(a, b)).length
    // Not every pair links directly; single linkage chains them into one cluster.
    expect(merged).toBeGreaterThanOrEqual(pairs.length / 2)
  })

  it('does not merge different Anthropic stories that merely share the company name', () => {
    for (const other of [
      'Scoop: Anthropic whistleblower gave up his equity to leave the company',
      'Anthropic Drops Stark AI Forecast for U.S. Economy',
      'Emil Michael stands by Anthropic blacklist',
    ]) {
      for (const bio of BIO) expect(same(bio, other)).toBe(false)
    }
  })

  it('rejects same-template different-entity stories', () => {
    const traps: [string, string][] = [
      ['Trump announces new tariffs on Chinese steel imports', 'Trump announces new tariffs on Mexican avocado imports'],
      ['Arsenal beat Chelsea 2-0 in the Premier League', 'Liverpool beat Everton 3-1 in the Premier League'],
      ['OpenAI launches ChatGPT for Financial Services', 'OpenAI launches Sora for video editing'],
    ]
    const trapDf = buildDocFrequency(traps.flat())
    const trapMax = distinctivenessCutoff(traps.flat().length)
    for (const [a, b] of traps) expect(sameStory(a, b, trapDf, trapMax)).toBe(false)
  })

  it('needs distinctive shared tokens, not just ambient ones', () => {
    // 'anthropic' is in most of the corpus, so sharing only it must not merge.
    expect(same(
      'Anthropic opens a new office in Dublin to serve European customers',
      'Anthropic names a chief financial officer ahead of an expected funding round',
    )).toBe(false)
  })
})

describe('properNouns', () => {
  it('finds entities in sentence-case headlines', () => {
    expect(properNouns('Anthropic blocks accounts of several scientists in Boston')).toEqual(
      new Set(['anthropic', 'boston']),
    )
    // the leading entity must be included, or these two look identical
    const a = properNouns('Anthropic blocks accounts of several scientists in Boston')
    const b = properNouns('OpenAI blocks accounts of several scientists in Boston')
    expect([...a].some(w => !b.has(w)) && [...b].some(w => !a.has(w))).toBe(true)
  })
  it('returns empty for Title Case, where capitalisation carries no signal', () => {
    expect(properNouns('Anthropic Drops Stark AI Forecast For The U.S. Economy').size).toBe(0)
  })
  it('ignores parenthetical attributions', () => {
    expect(properNouns('Anthropic says it disrupted several plots (Dustin Volz/New York Times)').has('volz')).toBe(false)
  })
})
