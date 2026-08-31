import { describe, it, expect } from 'vitest'
import { enforceOneLiner } from './shape'

describe('enforceOneLiner', () => {
  // The three real drafts the team re-edited by hand, with their edits as the
  // expected output. These are the spec.
  it('trims the MLB draft to the reviewer edit', () => {
    const draft = '🟣⚾ JUST IN: MLB has suspended a Dominican prospect with a 2029 signing agreement to the Guardians after he allegedly falsified his age and identity. Age fraud in prospect development undermines the entire pipeline, but the real question is how deep this goes. Does MLB tighten vetting across Latin American academies, or does the system absorb this and move on? 🔮'
    expect(enforceOneLiner(draft)).toBe(
      '🟣 JUST IN: MLB has suspended a Dominican prospect with a 2029 signing agreement to the Guardians after he allegedly falsified his age and identity.'
    )
  })

  it('trims the Venezuela draft without breaking on "U.S."', () => {
    const draft = "🟣🏛️ BREAKING: Trump says the U.S. has secured majority control of a large slice of Venezuela's oil reserves through a new agreement. The move signals a major shift in U.S. energy and geopolitical strategy toward Maduro's regime. Does this deal hold through implementation, or does Venezuela's government reverse course under pressure? 🔮"
    expect(enforceOneLiner(draft)).toBe(
      "🟣 BREAKING: Trump says the U.S. has secured majority control of a large slice of Venezuela's oil reserves through a new agreement."
    )
  })

  it('trims the AOC draft to the reviewer edit', () => {
    const draft = '🟣🗳️ JUST IN: AOC is reshaping her team with several departures and new aides, sources tell Axios, months before she decides on a 2028 move. Personnel shifts often signal a shift in political direction or ambition. Does she run for higher office, or consolidate her House seat? 🔮'
    expect(enforceOneLiner(draft)).toBe(
      '🟣 JUST IN: AOC is reshaping her team with several departures and new aides, sources tell Axios, months before she decides on a 2028 move.'
    )
  })

  it('is idempotent — already-shaped text is unchanged', () => {
    const shaped = '🟣 JUST IN: AOC is reshaping her team with several departures and new aides, sources tell Axios, months before she decides on a 2028 move.'
    expect(enforceOneLiner(shaped)).toBe(shaped)
  })

  it('keeps the tech tag', () => {
    const draft = '⚪️🤖 NEW: Micron just inked a memory and storage supply deal with Anthropic, locking in AI demand. Who is the next chipmaker to land a frontier lab?'
    expect(enforceOneLiner(draft)).toBe(
      '⚪️ NEW: Micron just inked a memory and storage supply deal with Anthropic, locking in AI demand.'
    )
  })

  it('keeps the weather tag', () => {
    const draft = '🌪️ WARNING: Tornado warning issued for northwestern Baldwin and southwestern Putnam counties in central Georgia until 9:15 PM EDT.'
    expect(enforceOneLiner(draft)).toBe(draft)
  })

  it('does not split on a decimal', () => {
    const draft = '🟣 NEW: The 10Y rose 0.05pt to 4.81% after the borrowing print. Does one by-election move rate expectations? 🔮'
    expect(enforceOneLiner(draft)).toBe('🟣 NEW: The 10Y rose 0.05pt to 4.81% after the borrowing print.')
  })

  it('does not split on a known abbreviation before a capitalized word', () => {
    const draft = '🟣 JUST IN: Portugal vs. Uzbekistan kicks off Tuesday. Cruise, or is an upset brewing? 🔮'
    expect(enforceOneLiner(draft)).toBe('🟣 JUST IN: Portugal vs. Uzbekistan kicks off Tuesday.')
  })

  it('strips a trailing emoji when the line has no terminal punctuation', () => {
    expect(enforceOneLiner('🟣 JUST IN: Bitcoin is pushing higher 📈')).toBe('🟣 JUST IN: Bitcoin is pushing higher')
  })

  it('defaults to the general tag when none is present', () => {
    expect(enforceOneLiner('BREAKING: Something happened. And then more.')).toBe('🟣 BREAKING: Something happened.')
  })

  it('handles empty input', () => {
    expect(enforceOneLiner('')).toBe('')
  })
})
