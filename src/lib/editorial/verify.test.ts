/**
 * The evidence verifier must fail CLOSED on invented evidence and must NOT fail
 * on typography. Production discarded at least 424 drafts in one week that the
 * model had judged supported, because it compared excerpts to the source byte
 * for byte and the model returns straight quotes where edited copy has curly
 * ones. The source below is the real one from that week.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { verifyDraft, normalizeForMatch, excerptsInSource } from './verify'
import type { Evidence } from './evidence'

const TRUMP_SOURCE =
  'Trump to sign order renaming AI as ‘superintelligence’\n' +
  'President Trump plans to sign an order Tuesday officially renaming AI as “superintelligence.” ' +
  '“We’re going to be signing a document today at about 5o’clock, renaming artificial intelligence ' +
  'because it’s not artificial,” Trump said in public remarks.'

const evidence = (text: string): Evidence => ({
  headline: text.split('\n')[0], text, publishedAt: Date.now() - 60_000, ingestedAt: Date.now(),
  source: 'Test', url: 'https://example.com/a', timestampKnown: true, primary: false,
})

function modelSays(result: object) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ content: [{ text: JSON.stringify(result) }] }), { status: 200 }),
  )
}

describe('excerpt matching', () => {
  it('treats curly and straight quotes, dashes and ellipses as the same text', () => {
    expect(normalizeForMatch('We’re “here” — now…')).toBe(normalizeForMatch('We\'re "here" - now...'))
  })

  it('still requires the WORDS to match exactly', () => {
    expect(excerptsInSource(['renaming AI as "superintelligence."'], TRUMP_SOURCE)).toBe(true)
    expect(excerptsInSource(['renaming AI as "hyperintelligence."'], TRUMP_SOURCE)).toBe(false)
  })
})

describe('verifyDraft', () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  afterEach(() => vi.restoreAllMocks())
  const draft = '🟣 JUST IN: President Trump plans to sign an order Tuesday officially renaming AI as "superintelligence."'

  it('accepts a supported draft whose excerpts use straight quotes (the production failure)', async () => {
    // Verbatim what Haiku returned in all four reproduction trials.
    modelSays({
      supported: true,
      evidence: [
        'President Trump plans to sign an order Tuesday officially renaming AI as "superintelligence."',
        '"We\'re going to be signing a document today at about 5o\'clock, renaming artificial intelligence',
      ],
      reason: 'All factual assertions in the draft are directly supported by the source.',
    })
    await expect(verifyDraft(draft, evidence(TRUMP_SOURCE))).resolves.toMatchObject({ supported: true })
  })

  it('still rejects an excerpt that is not in the source at all', async () => {
    modelSays({ supported: true, evidence: ['Trump signed the order at a White House ceremony on Monday.'], reason: 'ok' })
    await expect(verifyDraft(draft, evidence(TRUMP_SOURCE))).rejects.toThrow('unsupported claim')
  })

  it('still rejects when the model says unsupported', async () => {
    modelSays({ supported: false, evidence: ['President Trump plans to sign an order'], reason: 'adds a date' })
    await expect(verifyDraft(draft, evidence(TRUMP_SOURCE))).rejects.toThrow('unsupported claim')
  })

  it('still rejects a supported verdict that cites no evidence', async () => {
    modelSays({ supported: true, evidence: [], reason: 'looks fine' })
    await expect(verifyDraft(draft, evidence(TRUMP_SOURCE))).rejects.toThrow('unsupported claim')
  })

  it('keeps the deterministic number check ahead of the model', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    await expect(verifyDraft('🟣 JUST IN: Trump will sign 3 orders on Tuesday.', evidence(TRUMP_SOURCE)))
      .rejects.toThrow('unsupported numeric')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('deterministic number check', () => {
  it('accepts "$20 billion" when the source says "$20B" (real Boeing headline)', async () => {
    const { checkFactualSupport } = await import('./evidence')
    expect(() => checkFactualSupport('Boeing won a $20 billion Navy contract.', "Boeing nabs $20B contract for Navy's futuristic fighter")).not.toThrow()
    expect(() => checkFactualSupport('Hackers stole $351.6 million.', 'Hackers steal $351.6M in Bitget exchange hack')).not.toThrow()
  })

  it('still rejects a number the source does not contain', async () => {
    const { checkFactualSupport } = await import('./evidence')
    expect(() => checkFactualSupport('Boeing won a $30 billion Navy contract.', "Boeing nabs $20B contract for Navy's futuristic fighter")).toThrow('unsupported numeric detail: 30')
    expect(() => checkFactualSupport('Man City were found guilty on 115 charges.', 'Premier League confirm Man City guilty of all charges')).toThrow('unsupported numeric detail: 115')
  })

  it('treats "09" and "9" as the same value', async () => {
    const { checkFactualSupport } = await import('./evidence')
    expect(() => checkFactualSupport('The match is on 9 October.', 'Kick-off 09 October')).not.toThrow()
  })
})
