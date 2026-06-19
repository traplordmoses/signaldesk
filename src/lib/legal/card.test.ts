import { describe, it, expect } from 'vitest'
import { renderLegalBlock } from './card'

describe('renderLegalBlock', () => {
  it('returns null when there is no verdict (feature off / unreviewed)', () => {
    expect(renderLegalBlock({})).toBeNull()
    expect(renderLegalBlock({ verdict: null })).toBeNull()
  })

  it('renders a pass verdict with risk + rationale', () => {
    const out = renderLegalBlock({ verdict: 'pass', risk: 'low', rationale: 'looks fine' })!
    expect(out).toContain('⚖️')
    expect(out).toContain('✅ Pass')
    expect(out).toContain('risk **low**')
    expect(out).toContain('_looks fine_')
  })

  it('renders a flag verdict with a suggested redline', () => {
    const out = renderLegalBlock({ verdict: 'flag', risk: 'high', rationale: 'guarantee language', redline: 'drop the guarantee' })!
    expect(out).toContain('⚠️ Flag')
    expect(out).toContain('risk **high**')
    expect(out).toContain('**Suggested:** drop the guarantee')
  })

  it('omits the risk chip when risk is unknown', () => {
    const out = renderLegalBlock({ verdict: 'error', risk: 'unknown', rationale: 'unavailable' })!
    expect(out).toContain('❓ Review unavailable')
    expect(out).not.toContain('risk **')
  })
})
