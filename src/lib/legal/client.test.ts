import { describe, it, expect } from 'vitest'
import { reviewContent, stubReview, fromWire, type LegalReviewRequest } from './client'

const baseReq: LegalReviewRequest = {
  id: 'p1',
  text: 'Markets rally as the Fed holds rates steady.',
  postType: 'news',
  context: {
    headline: 'Fed holds rates',
    category: 'economics',
    topics: [],
    sources: ['Reuters'],
    contentMode: 'pure_news',
    riskLevel: 'low',
    riskReasons: [],
  },
}

describe('stubReview', () => {
  it('passes clean low-risk content', () => {
    const r = stubReview(baseReq)
    expect(r.verdict).toBe('pass')
    expect(r.risk).toBe('low')
    expect(r.rationale).toContain('[stub]')
  })

  it('flags investment-guarantee language', () => {
    const r = stubReview({ ...baseReq, text: "This bet is risk-free — you can't lose." })
    expect(r.verdict).toBe('flag')
    expect(r.categories).toContain('financial')
  })

  it('flags high upstream risk even on neutral text', () => {
    const r = stubReview({
      ...baseReq,
      context: { ...baseReq.context, riskLevel: 'high', riskReasons: ['nuclear'] },
    })
    expect(r.verdict).toBe('flag')
    expect(r.risk).toBe('high')
  })
})

describe('reviewContent (stub mode — no LEGAL_REVIEW_URL in test env)', () => {
  it('returns a stub verdict end-to-end', async () => {
    const r = await reviewContent(baseReq)
    expect(['pass', 'flag', 'block']).toContain(r.verdict)
    expect(r.rationale).toContain('[stub]')
  })
})

describe('fromWire (Legal Agent response mapping)', () => {
  it('maps a well-formed response', () => {
    const r = fromWire({
      verdict: 'block',
      risk_level: 'high',
      categories: ['regulatory'],
      redline: 'remove the guarantee',
      rationale: 'implies certainty',
      review_id: 'rv1',
    })
    expect(r).toMatchObject({
      verdict: 'block',
      risk: 'high',
      categories: ['regulatory'],
      redline: 'remove the guarantee',
      reviewId: 'rv1',
    })
  })

  it('degrades an unknown/missing verdict to flag (safe default)', () => {
    expect(fromWire({ verdict: 'weird' }).verdict).toBe('flag')
    expect(fromWire({}).verdict).toBe('flag')
  })

  it('handles missing risk and optional fields', () => {
    const r = fromWire({ verdict: 'pass' })
    expect(r.verdict).toBe('pass')
    expect(r.risk).toBe('unknown')
    expect(r.categories).toEqual([])
    expect(r.redline).toBeNull()
  })
})
