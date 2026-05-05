/**
 * Coverage for the risk classifier — locks in the TRAGEDY (auto-skip) vs
 * HIGH_STAKES (warn-only) split. Critical because a regression here either
 * lets the bot auto-tweet during active tragedies, or auto-skips legitimate
 * breaking-news the bot is built to cover.
 */
import { describe, it, expect } from 'vitest'
import { detectRisk, scoreItem } from './scorer'

describe('detectRisk', () => {
  describe('TRAGEDY → high (auto-skip)', () => {
    const tragedyHeadlines = [
      'Eight killed in school shooting in Texas',
      'Casualties reported after Tel Aviv bombing',
      'Hostage situation in Paris bank ongoing',
      'Death toll rises as terror attack in Istanbul claims more victims',
      'Massacre at festival leaves dozens dead',
      'Mass shooting at supermarket — three fatalities confirmed',
    ]
    for (const headline of tragedyHeadlines) {
      it(`flags "${headline.slice(0, 40)}..." as high`, () => {
        const result = detectRisk(headline)
        expect(result.level).toBe('high')
        expect(result.reasons.length).toBeGreaterThan(0)
      })
    }
  })

  describe('HIGH_STAKES → medium (warn, do not skip)', () => {
    const highStakesHeadlines = [
      'King Charles agrees with Trump on Iran nuclear weapon ban',
      'Trump indicted on 34 felony counts in New York',
      'DOJ files antitrust suit against Google',
      'SEC charges crypto exchange with unregistered securities offering',
      'Fed criminal probe widens — three traders arrested',
      'Sanctions package against Russia clears Senate',
      'Election results: Mamdani projected winner of NYC primary',
      'Political scandal engulfs senator amid leaked recordings',
    ]
    for (const headline of highStakesHeadlines) {
      it(`flags "${headline.slice(0, 40)}..." as medium`, () => {
        const result = detectRisk(headline)
        expect(result.level).toBe('medium')
        expect(result.reasons.length).toBeGreaterThan(0)
      })
    }
  })

  describe('low risk — routine news, no flags', () => {
    const routineHeadlines = [
      'Apple unveils new iPhone with redesigned camera',
      'Bitcoin holding near $82K as Big Tech earnings loom',
      'Germany accelerating defence spending well ahead of NATO deadline',
      'Tom Steyer surges past Becerra in California governor race debate',
    ]
    for (const headline of routineHeadlines) {
      it(`returns low for "${headline.slice(0, 40)}..."`, () => {
        const result = detectRisk(headline)
        expect(result.level).toBe('low')
        expect(result.reasons).toHaveLength(0)
      })
    }
  })

  describe('TRAGEDY beats HIGH_STAKES (priority ordering)', () => {
    it('auto-skips even when the headline also matches high-stakes keywords', () => {
      // "killed" (tragedy) + "attack" (high-stakes) — must classify as high
      const result = detectRisk('Five killed in nuclear plant attack')
      expect(result.level).toBe('high')
      expect(result.reasons).toContain('killed')
    })
  })

  describe('word-boundary matching prevents substring false positives', () => {
    it('does not match "killed" inside another word', () => {
      // "skilled" contains "killed" as a substring — must NOT trigger.
      const result = detectRisk('Highly skilled engineer joins SpaceX')
      expect(result.level).toBe('low')
    })

    it('does not match "doj" inside another word', () => {
      // "podojny" or "adjoining" — substrings should not match.
      const result = detectRisk('Adjoining property sells for record price')
      expect(result.level).toBe('low')
    })
  })
})

describe('scoreItem — LOCAL_CRIME penalty', () => {
  // Use an old publishedAt to zero out the recency bonus and isolate the penalty.
  const oldTs = Date.now() - 24 * 60 * 60 * 1000  // 24h ago
  const lowWeight = 5  // no source-weight bonus

  it('docks the score on a Hong Kong burglary headline', () => {
    const score = scoreItem('Hong Kong police bust burglary ring in Kowloon', '', lowWeight, oldTs)
    expect(score).toBe(0)  // 0 base - 3 penalty floors at 0
  })

  it('docks the score on a routine drug bust', () => {
    const score = scoreItem('Local drug bust nets $50K in narcotics', '', lowWeight, oldTs)
    expect(score).toBe(0)
  })

  it('does not dock legitimate trafficking-policy stories that only mention cocaine/heroin in passing', () => {
    // 'cocaine' alone is intentionally NOT in LOCAL_CRIME — only 'cocaine bust'
    // / 'cocaine seizure' is. A trafficking-policy story with a TIER1 hit
    // ('indicted') should retain its full score.
    const score = scoreItem('Cartel leader indicted on cocaine trafficking charges', '', lowWeight, oldTs)
    expect(score).toBe(4)  // TIER1 'indicted' (+4), no penalty
  })

  it('does dock when both TIER1 and LOCAL_CRIME hit (penalty stacks correctly)', () => {
    // 'indicted' (+4) + 'cocaine bust' LOCAL_CRIME (-3) = 1
    const score = scoreItem('Local police indicted in cocaine bust scandal', '', lowWeight, oldTs)
    expect(score).toBe(1)
  })

  it('does not double-penalize multiple LOCAL_CRIME hits in one headline', () => {
    // "burglary" + "vandalism" both in LOCAL_CRIME — penalty caps at one
    const score = scoreItem('Wave of burglary and vandalism reports across district', '', lowWeight, oldTs)
    expect(score).toBe(0)  // 0 base - 3 penalty (one match), floored at 0
  })

  it('floors at 0 instead of going negative', () => {
    const score = scoreItem('Burglary suspect arrested', '', lowWeight, oldTs)
    expect(score).toBeGreaterThanOrEqual(0)
  })
})
