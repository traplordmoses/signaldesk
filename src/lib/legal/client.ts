/**
 * Probly Legal Redline Bot client — the News-Bot side of the integration
 * (see LEGAL_REDLINE_INTEGRATION.md). Sends a generated draft to the Legal
 * Agent and returns a structured verdict.
 *
 * Two modes, chosen by env:
 *   - **stub** (default when no LEGAL_REVIEW_URL): a deterministic local
 *     stand-in so the whole flow — generate → review → verdict on the Lark
 *     card — works end-to-end BEFORE John Tang's API exists. It is NOT a real
 *     legal model; it just exercises the pipeline and clearly labels itself.
 *   - **live**: POST to LEGAL_REVIEW_URL. **Fail-open** — a timeout/5xx never
 *     blocks a draft; it returns verdict 'error' and the card shows
 *     "review unavailable" so a human still decides.
 *
 * The request/response wire shapes follow LEGAL_REDLINE_INTEGRATION.md §5–§6
 * (the proposed contract). Adjust toWire()/fromWire() once John's schema is
 * final — that's the only thing that should need to change to go live.
 */

export type LegalVerdict = 'pass' | 'flag' | 'block' | 'error'
export type LegalRisk = 'low' | 'medium' | 'high' | 'unknown'

export interface LegalReviewRequest {
  id: string
  text: string
  imageUrl?: string
  postType: 'news' | 'platform_event' | 'meme'
  context: {
    headline: string
    category: string
    topics: string[]
    sources: string[]
    contentMode: string
    marketLink?: string
    riskLevel?: string | null
    riskReasons?: string[]
  }
}

export interface LegalReviewResult {
  verdict: LegalVerdict
  risk: LegalRisk
  categories: string[]
  redline: string | null
  rationale: string
  reviewId: string | null
  reviewedAt: number
}

const REVIEW_URL = process.env.LEGAL_REVIEW_URL
const REVIEW_TOKEN = process.env.LEGAL_REVIEW_TOKEN
const MODE = (process.env.LEGAL_REVIEW_MODE || (REVIEW_URL ? 'live' : 'stub')).toLowerCase()
const TIMEOUT_MS = Number(process.env.LEGAL_REVIEW_TIMEOUT_MS ?? 8000)

export async function reviewContent(req: LegalReviewRequest): Promise<LegalReviewResult> {
  if (MODE !== 'live' || !REVIEW_URL) return stubReview(req)

  try {
    const res = await fetch(REVIEW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(REVIEW_TOKEN ? { Authorization: `Bearer ${REVIEW_TOKEN}` } : {}),
      },
      body: JSON.stringify(toWire(req)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return fromWire(await res.json())
  } catch (e) {
    // Fail-open: never block a draft because the Legal Agent is unreachable.
    return {
      verdict: 'error',
      risk: 'unknown',
      categories: [],
      redline: null,
      rationale: `Legal review unavailable (${(e as Error).message}). Posting allowed; review manually.`,
      reviewId: null,
      reviewedAt: Date.now(),
    }
  }
}

// ─── wire mapping (adjust when John's schema is final) ───

/** Our request → the proposed wire contract (§5). */
function toWire(req: LegalReviewRequest) {
  return {
    id: req.id,
    text: req.text,
    image_url: req.imageUrl ?? null,
    post_type: req.postType,
    context: {
      headline: req.context.headline,
      category: req.context.category,
      topics: req.context.topics,
      sources: req.context.sources,
      content_mode: req.context.contentMode,
      market_link: req.context.marketLink ?? null,
      upstream_risk_level: req.context.riskLevel ?? null,
      upstream_risk_reasons: req.context.riskReasons ?? [],
    },
  }
}

/**
 * Legal Agent response (§6) → our result. Defensive: an unrecognized verdict
 * degrades to 'flag' (a human looks) rather than silently passing.
 */
export function fromWire(data: unknown): LegalReviewResult {
  const d = (data ?? {}) as Record<string, unknown>
  const v = String(d.verdict ?? '').toLowerCase()
  const verdict: LegalVerdict = v === 'pass' || v === 'flag' || v === 'block' ? v : 'flag'
  const r = String(d.risk_level ?? d.risk ?? '').toLowerCase()
  const risk: LegalRisk = r === 'low' || r === 'medium' || r === 'high' ? r : 'unknown'
  return {
    verdict,
    risk,
    categories: Array.isArray(d.categories) ? d.categories.map(String) : [],
    redline: typeof d.redline === 'string' ? d.redline : null,
    rationale: typeof d.rationale === 'string' ? d.rationale : '(no rationale returned)',
    reviewId: typeof d.review_id === 'string' ? d.review_id : null,
    reviewedAt: Date.now(),
  }
}

// ─── stub (deterministic local stand-in; replace with the real Agent) ───

const STUB_FLAGS: { kw: string[]; category: string; note: string }[] = [
  { kw: ['guarantee', 'guaranteed', 'risk-free', 'risk free', "can't lose", 'sure thing'], category: 'financial', note: 'investment-guarantee / no-risk language' },
  { kw: ['rigged', 'stolen election', 'voter fraud'], category: 'political', note: 'election-integrity claim' },
  { kw: ['insider'], category: 'regulatory', note: 'possible insider-information framing' },
  { kw: ['cure ', 'miracle'], category: 'health', note: 'health/medical claim' },
]

export function stubReview(req: LegalReviewRequest): LegalReviewResult {
  const text = req.text.toLowerCase()
  const matched = STUB_FLAGS.filter(f => f.kw.some(k => text.includes(k)))
  const highUpstream = req.context.riskLevel === 'high'

  if (matched.length > 0 || highUpstream) {
    const categories = [...new Set(matched.map(m => m.category))]
    if (highUpstream && categories.length === 0) categories.push('general')
    const notes = matched.map(m => m.note)
    if (highUpstream) {
      notes.push(`upstream riskLevel=high (${(req.context.riskReasons ?? []).join(', ') || 'unspecified'})`)
    }
    return {
      verdict: 'flag',
      risk: highUpstream ? 'high' : 'medium',
      categories,
      redline: null,
      rationale: `[stub] Flagged for human review: ${notes.join('; ')}. (Local stub — swap in the real Legal Agent.)`,
      reviewId: null,
      reviewedAt: Date.now(),
    }
  }

  return {
    verdict: 'pass',
    risk: req.context.riskLevel === 'medium' ? 'medium' : 'low',
    categories: [],
    redline: null,
    rationale: '[stub] No obvious legal/compliance issues. (Local stub — swap in the real Legal Agent.)',
    reviewId: null,
    reviewedAt: Date.now(),
  }
}
