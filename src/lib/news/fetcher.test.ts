/**
 * Coverage for the Google News publisher filter on fetchMarketDrivenNews.
 * The May 5 review surfaced Crypto Briefing and Rolling Out leaking through
 * the markets-driven news pull — root cause was no publisher gating on
 * Google News results. Title-suffix parsing + allowlist locks this down.
 */
import { describe, it, expect } from 'vitest'
import { parseGoogleNewsTitle, isTrustedPublisher } from './fetcher'

describe('parseGoogleNewsTitle', () => {
  it('extracts publisher from a standard Google News title', () => {
    const { title, publisher } = parseGoogleNewsTitle('Trump indicted on 34 felony counts - The New York Times')
    expect(title).toBe('Trump indicted on 34 felony counts')
    expect(publisher).toBe('the new york times')
  })

  it('takes the last separator when the headline contains hyphens', () => {
    const { title, publisher } = parseGoogleNewsTitle("Senator's plan to break up Big Tech - what to know - The Hill")
    expect(title).toBe("Senator's plan to break up Big Tech - what to know")
    expect(publisher).toBe('the hill')
  })

  it('returns empty publisher when no separator', () => {
    const { title, publisher } = parseGoogleNewsTitle('Headline with no publisher info')
    expect(title).toBe('Headline with no publisher info')
    expect(publisher).toBe('')
  })

  it('handles null/undefined safely', () => {
    expect(parseGoogleNewsTitle('')).toEqual({ title: '', publisher: '' })
  })
})

describe('isTrustedPublisher', () => {
  describe('trusted publishers pass', () => {
    const trusted = [
      'Reuters', 'Bloomberg', 'The New York Times', 'NYT', 'WSJ',
      'CNN', 'BBC News', 'NPR', 'Politico', 'Axios',
      'CNBC', 'MarketWatch', 'The Guardian',
      'ESPN', 'The Athletic',
      'CoinDesk', 'Cointelegraph',
    ]
    for (const p of trusted) {
      it(`accepts "${p}"`, () => {
        expect(isTrustedPublisher(p)).toBe(true)
      })
    }
  })

  describe('case-insensitive matching', () => {
    it('accepts lowercase', () => {
      expect(isTrustedPublisher('reuters')).toBe(true)
    })
    it('accepts uppercase', () => {
      expect(isTrustedPublisher('REUTERS')).toBe(true)
    })
    it('accepts mixed case', () => {
      expect(isTrustedPublisher('ReUtErS')).toBe(true)
    })
  })

  describe('untrusted publishers are rejected', () => {
    const untrusted = [
      'Crypto Briefing',  // explicit May 5 callout
      'Rolling Out',      // explicit May 5 callout
      'Random Blog',
      'Some SEO Site',
      "Joe's Crypto Newsletter",
    ]
    for (const p of untrusted) {
      it(`rejects "${p}"`, () => {
        expect(isTrustedPublisher(p)).toBe(false)
      })
    }
  })

  it('rejects empty string', () => {
    expect(isTrustedPublisher('')).toBe(false)
  })

  it('trims whitespace before matching', () => {
    expect(isTrustedPublisher('  Reuters  ')).toBe(true)
  })
})
