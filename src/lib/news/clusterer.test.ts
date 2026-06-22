/**
 * Coverage for the cluster-merge eligibility check. The bug it addresses:
 * five separate cards for the same Trump-EU tariff event over an hour because
 * each cron tick saw new items in isolation. The merge pass requires ≥2 shared
 * TIER1/TIER2 keywords with an existing same-category cluster created in the
 * last 60 minutes.
 */
import { describe, it, expect } from 'vitest'
import { shouldMergeIntoExisting, topicalTokens, keywordOverlap } from './clusterer'
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
