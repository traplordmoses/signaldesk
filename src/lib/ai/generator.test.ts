/**
 * Coverage for the post-generation hallucination validators.
 * Tickers and percentages are unambiguous identifiers — if they appear in
 * output but not in the source context, the model made them up and we
 * should reject the post rather than ship it.
 */
import { describe, it, expect } from 'vitest'
import { __testing } from './generator'

const { checkForFabricatedTickers, checkForFabricatedPercentages } = __testing

describe('checkForFabricatedTickers', () => {
  it('passes when ticker in output is also in context (with $)', () => {
    expect(() =>
      checkForFabricatedTickers('Apple beats estimates. $AAPL up 4%.', 'Apple ($AAPL) beat estimates this morning.')
    ).not.toThrow()
  })

  it('passes when ticker in output appears bare-capitalized in context', () => {
    expect(() =>
      checkForFabricatedTickers('AAPL up 4%.', 'AAPL beat estimates this morning.')
    ).not.toThrow()
  })

  it('throws when output invents a ticker not in context', () => {
    expect(() =>
      checkForFabricatedTickers('FRM Materials surging on AI demand. $FRMM up 12%.', 'FRM Materials announced a new partnership.')
    ).toThrow(/fabricated ticker/)
  })

  it('throws on the actual May 5 review failure case', () => {
    expect(() =>
      checkForFabricatedTickers('Tesla suppliers see record demand. $FRMM, $TSLA both gaining.', 'Tesla announced record Q1 deliveries.')
    ).toThrow(/\$FRMM/)
  })

  it('passes when no tickers in output regardless of context', () => {
    expect(() =>
      checkForFabricatedTickers('Tesla suppliers see record demand.', 'Tesla announced record Q1 deliveries.')
    ).not.toThrow()
  })

  it('treats class-suffix tickers (BRK.A) as distinct symbols', () => {
    expect(() =>
      checkForFabricatedTickers('Berkshire halts buyback. $BRK.A flat.', 'Berkshire Hathaway BRK.A halted buybacks.')
    ).not.toThrow()
  })
})

describe('checkForFabricatedPercentages', () => {
  it('passes when output % matches context %', () => {
    expect(() =>
      checkForFabricatedPercentages('Mamdani at 61% in primary.', 'Mamdani polling 61% ahead of primary.')
    ).not.toThrow()
  })

  it('passes within ±1 rounding tolerance', () => {
    expect(() =>
      checkForFabricatedPercentages('Mamdani at 61%.', 'Mamdani polling 60.5%.')
    ).not.toThrow()
  })

  it('throws when output invents a percentage', () => {
    expect(() =>
      checkForFabricatedPercentages('Trump approval drops to 38%.', 'Trump approval has slipped recently.')
    ).toThrow(/fabricated percentage/)
  })
})
