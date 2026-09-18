/**
 * Coverage for the redesigned scorer + the risk classifier.
 *
 * Two contracts are locked in here:
 *  1. detectRisk — the TRAGEDY (auto-skip) vs HIGH_STAKES (warn-only) split.
 *     A regression either lets the bot auto-tweet during active tragedies, or
 *     auto-skips legitimate breaking-news the bot is built to cover.
 *  2. scoreItem — the optimism-weighted, Polymarket-category model: marquee +
 *     positive stories rise, gore/doom is penalised into the floor, and the
 *     geopolitics TOPIC survives while gore FRAMING does not.
 *
 * The market-fit signal is the spine of the real score but depends on the live
 * market_topics cache, so it's exercised end-to-end in scripts/backtest-scoring.ts.
 * Here we point the lazy-loaded DB at a throwaway temp file so market-fit is a
 * hermetic 0 and these assertions test the deterministic keyword/valence/ceiling
 * logic in isolation.
 */
import { describe, it, expect } from 'vitest'
// Isolated database via src/test/setup.ts. (A DB_PATH assignment here used to
// sit above the imports and never took effect — imports are hoisted.)
import { detectRisk, scoreItem, detectCategory } from './scorer'

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

describe('scoreItem — optimism-weighted model', () => {
  const oldTs = Date.now() - 24 * 60 * 60 * 1000   // 24h ago — no recency bonus
  const freshTs = Date.now() - 30 * 60 * 1000       // 30 min ago — recency active
  const lowWeight = 5   // no source-weight bonus
  const midWeight = 7   // +0.5 source
  const highWeight = 9  // +1.0 source

  describe('marquee + positive stories rise', () => {
    it('a marquee story with a full bonus stack clears the old 8 cap', () => {
      // crypto (marquee, +3) + anticipation (+2) + positive (+2) + ticker (+1.5)
      // + source (+1) + recency (+0.5) = 10. The marquee ceiling lets it exceed 8.
      const score = scoreItem('Bitcoin set to hit a record all-time high this week', '', highWeight, freshTs)
      expect(score).toBeGreaterThan(8)
    })

    it('rewards forward-looking "before it happens" framing', () => {
      const withAnticipation = scoreItem('Ethereum set to hit a record high this week', '', lowWeight, oldTs)
      const without = scoreItem('Ethereum at a record high', '', lowWeight, oldTs)
      expect(withAnticipation).toBeGreaterThan(without)
    })

    it('rewards optimism over doom on the same marquee topic', () => {
      const upbeat = scoreItem('Bitcoin surges to a record high', '', lowWeight, oldTs)
      const doom = scoreItem('Bitcoin crashes as crypto market plunges', '', lowWeight, oldTs)
      expect(upbeat).toBeGreaterThan(doom)
      expect(doom).toBeLessThan(4)
    })

    it('does not penalise "killed" hiding inside another word (skilled)', () => {
      const score = scoreItem('Highly skilled striker wins the championship', '', lowWeight, oldTs)
      expect(score).toBeGreaterThanOrEqual(3)
    })
  })

  describe('the marquee/market ceiling rule', () => {
    it('caps a non-marquee, no-market story at 8 even with a full bonus stack', () => {
      // economy (non-marquee, +2) + anticipation (+2) + positive (+2)
      // + ticker (+1.5) + source (+1) + recency (+0.5) = 9 → capped at 8.
      const score = scoreItem(
        'Goldman Sachs set to post record earnings beats ahead of Fed decision this week',
        '',
        highWeight,
        freshTs,
      )
      expect(score).toBe(8)
    })
  })

  // Two policies, both kept reachable (src/lib/policy.ts). Strict mode is the
  // original: gore framing floored to zero. The default since 2026-09-18 lets
  // sensitive stories compete, because they now go to legal review rather than
  // being pre-censored — and a floor would silently keep the old policy in place.
  const strict = <T,>(fn: () => T): T => {
    process.env.ALLOW_SENSITIVE_STORIES = '0'
    try { return fn() } finally { delete process.env.ALLOW_SENSITIVE_STORIES }
  }

  describe('gore is floored in STRICT mode, but the geopolitics topic survives', () => {
    it('docks gore framing to the floor', () => {
      const score = strict(() => scoreItem('40 killed as Russia shells Ukraine city', '', lowWeight, oldTs))
      expect(score).toBe(0)
      expect(detectRisk('40 killed as Russia shells Ukraine city').level).toBe('high')
    })

    it('keeps a neutral / de-escalation geopolitics market well above its gore version', () => {
      const deescalation = strict(() => scoreItem('Russia and Ukraine agree ceasefire deal', '', midWeight, oldTs))
      const gore = strict(() => scoreItem('40 killed as Russia shells Ukraine city', '', lowWeight, oldTs))
      expect(deescalation).toBeGreaterThan(3)
      expect(deescalation).toBeGreaterThan(gore)
    })
  })

  describe('sensitive stories allowed (the default)', () => {
    const DOORDASH = 'It has been revealed that a man accused of plotting an ISIS-inspired mass shooting was a moderator of the r/DoorDash subreddit'

    it('no longer floors a foiled-plot story to zero', () => {
      // Needs a realistic source weight and a fresh timestamp: at weight 5 and 24h
      // old there is no positive signal at all, so both modes clamp to 0 and the
      // test would prove nothing.
      expect(strict(() => scoreItem(DOORDASH, '', highWeight, freshTs))).toBe(0)
      expect(scoreItem(DOORDASH, '', highWeight, freshTs)).toBeGreaterThan(0)
    })

    it('still CLASSIFIES it as high risk, so the card is flagged for legal', () => {
      // Letting the story through must not blind the classifier: the risk level
      // is what puts the red SENSITIVE banner on the Lark card.
      expect(detectRisk(DOORDASH).level).toBe('high')
    })

    it('does not promote casualty reports — it only stops flooring them', () => {
      const calm = scoreItem('Russia and Ukraine agree ceasefire deal', '', midWeight, oldTs)
      const gore = scoreItem('40 killed as Russia shells Ukraine city', '', lowWeight, oldTs)
      expect(gore).toBeLessThanOrEqual(calm)
    })

    it('floors a doom headline that used to top the old ranking', () => {
      // Real old #1 (scored 8.5 under the previous model).
      const score = scoreItem('Lebanon accuses Israel of committing ‘ecocide’ in country since 2023', '', lowWeight, oldTs)
      expect(score).toBeLessThan(2)
    })
  })
})

describe('scoreItem — LOCAL_CRIME penalty', () => {
  // Use an old publishedAt to zero out the recency bonus and isolate the penalty.
  const oldTs = Date.now() - 24 * 60 * 60 * 1000  // 24h ago
  const lowWeight = 5  // no source-weight bonus

  it('docks the score on a Hong Kong burglary headline', () => {
    const score = scoreItem('Hong Kong police bust burglary ring in Kowloon', '', lowWeight, oldTs)
    expect(score).toBe(0)  // no category/market + 3 penalty floors at 0
  })

  it('docks the score on a routine drug bust', () => {
    const score = scoreItem('Local drug bust nets $50K in narcotics', '', lowWeight, oldTs)
    expect(score).toBe(0)
  })

  it('does not boost a legal-doom headline with no market or marquee category', () => {
    // 'indicted' is no longer a scoring keyword — the bot doesn't chase legal
    // doom. With no live market or marquee category, this scores at the floor.
    const score = scoreItem('Cartel leader indicted on cocaine trafficking charges', '', lowWeight, oldTs)
    expect(score).toBe(0)
  })

  it('stacks the local-crime + soft-negative penalties', () => {
    const score = scoreItem('Local police indicted in cocaine bust scandal', '', lowWeight, oldTs)
    expect(score).toBe(0)
  })

  it('does not double-penalize multiple LOCAL_CRIME hits in one headline', () => {
    const score = scoreItem('Wave of burglary and vandalism reports across district', '', lowWeight, oldTs)
    expect(score).toBe(0)
  })

  it('floors at 0 instead of going negative', () => {
    const score = scoreItem('Burglary suspect arrested', '', lowWeight, oldTs)
    expect(score).toBeGreaterThanOrEqual(0)
  })
})

describe('detectCategory — most-hits wins, no megacap hijack into tech_ai', () => {
  // Regression: a single megacap/marquee keyword used to hijack a story into
  // tech_ai/space (marquee weight 3), collapsing finance/gaming/culture into the
  // science_health bucket and mislabelling its emoji. Counting hits lets the
  // story's dominant signal win instead.
  const cases: [string, string][] = [
    ['Wall Street is chasing growth, but contrarian investors are loading up on value plays', 'economy_finance'],
    ['SpaceX kicked off marketing for its first-ever investment-grade bond sale', 'economy_finance'],
    ['Halo: Combat Evolved is dropping on PlayStation next month for the first time', 'gaming'],
    ['Romeo Beckham made his acting debut in a tennis romance film', 'pop_culture'],
    ['Micron inked a supply agreement with Anthropic for memory and storage', 'tech_ai'],
    ['Lionel Messi broke the World Cup all-time scoring record with his 17th goal', 'sports'],
    ['Bitcoin and altcoins are climbing but derivatives traders are hedging hard', 'crypto'],
  ]
  for (const [headline, expected] of cases) {
    it(`classifies "${headline.slice(0, 38)}…" as ${expected}`, () => {
      expect(detectCategory(headline)).toBe(expected)
    })
  }
})

/**
 * Frontier-AI priority (added 2026-09-10).
 *
 * AI news almost never maps to a live prediction market, so it can't earn the
 * market boost that is otherwise the spine of the scale. Before this, the story
 * the team asked about — Anthropic blocking bioweapons misuse attempts — scored
 * 2.50 against a 6.5 gate and could never be drafted, however many AI sources
 * were added. These lock in the counterweight AND its calibration: contested or
 * developing AI stories clear the gate, routine product notes do not.
 */
describe('frontier-AI priority', () => {
  const GATE = 6.5
  const fresh = () => Date.now() - 20 * 60_000
  const score = (h: string, s = '', w = 9) => scoreItem(h, s, w, fresh())

  it('clears the gate for the story that was missed', () => {
    const s = score(
      'Anthropic reveals it blocked several possible attempts to use Claude for biological weapons research, including work involving gain-of-function experiments at a military institute',
      'Anthropic said its threat intelligence team detected and blocked attempts to misuse Claude for bioweapons-related research, including gain-of-function work linked to a military institute.',
    )
    expect(s).toBeGreaterThanOrEqual(GATE)
  })

  it('does not treat "threat intelligence" as doom framing', () => {
    const neutral = score('Anthropic publishes its latest safety report', 'The company detailed new findings.')
    const jargon = score('Anthropic publishes its latest safety report', 'The company threat intelligence team detailed new findings.')
    expect(jargon).toBe(neutral)
  })

  it('still penalises genuine doom framing', () => {
    const calm = score('OpenAI publishes its quarterly safety report', 'Routine disclosure.')
    const doom = score('OpenAI publishes its quarterly safety report', 'The disclosure follows a scandal and a lawsuit.')
    expect(doom).toBeLessThan(calm)
  })

  it('clears the gate for contested and first-of-its-kind AI stories', () => {
    expect(score('OpenAI researcher resigns over safety disagreement, publishes open letter')).toBeGreaterThanOrEqual(GATE)
    expect(score('DeepSeek model outperforms Gemini on reasoning benchmark for the first ever time', '', 8)).toBeGreaterThanOrEqual(GATE)
  })

  it('does NOT clear the gate for routine AI product notes or passing mentions', () => {
    expect(score('OpenAI adds a new voice option to ChatGPT', 'OpenAI announced a minor update adding a voice preset.', 8)).toBeLessThan(GATE)
    expect(score('Retailer says it will use ChatGPT for customer service', 'A retail chain announced a customer service pilot.', 7)).toBeLessThan(GATE)
  })

  it('does not boost big-tech news that merely mentions a tech giant', () => {
    expect(score('Apple unveils new iPhone with improved battery', 'Apple announced its new iPhone lineup.')).toBeLessThan(GATE)
  })
})
