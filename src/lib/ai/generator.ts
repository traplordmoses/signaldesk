import { db } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog, settings } from '@/lib/db/schema'
import { eq, gt } from 'drizzle-orm'
import { SIGNALDESK_PROMPT_V1 } from './prompts'

// Daily LLM-generation cost cap. Reads `daily_post_limit` from settings (default 20),
// counts generated_posts in the last 24h, and blocks further generation when at/over.
function isOverDailyLimit(): { over: boolean; count: number; limit: number } {
  const setting = db.select().from(settings).limit(1).get()
  const limit = setting?.dailyPostLimit ?? 20
  const since = Date.now() - 24 * 60 * 60 * 1000
  const rows = db.select().from(generatedPosts).where(gt(generatedPosts.createdAt, since)).all()
  return { over: rows.length >= limit, count: rows.length, limit }
}

type ContentMode = 'pure_news' | 'news_odds' | 'engagement'
type Cluster = typeof eventClusters.$inferSelect

interface AIResponse {
  content_mode: ContentMode
  has_market: boolean
  include_link: boolean
  content: string
  char_count: number
  estimated_score: number
  score_explanation: string
}

// Patterns that indicate prompt-injection attempts in RSS-sourced content.
// We replace matches with [redacted] before assembling the user prompt so that
// adversarial headlines from feeds (or feeds-of-feeds) can't slip new instructions
// into the system role.
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\b(system|assistant|user)\s*:/gi,
  /ignore\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions|rules|prompts|directions)/gi,
  /\[INST\]|\[\/INST\]/gi,
  /<\|[^|]{1,40}\|>/g,
  /\bact\s+as\b/gi,
  /\bnew\s+(?:instructions|rules|task)\b/gi,
]

// Phrases that should NEVER appear in published output. If the AI emits one,
// we throw and fail the generation rather than ship potentially defamatory copy.
const BANNED_OUTPUT_PHRASES: RegExp[] = [
  /sec\s+(?:just\s+)?(?:opened|launched|filed)\s+(?:a\s+)?(?:criminal\s+)?(?:probe|investigation)/i,
  /\bcriminal\s+probe\b/i,
  /\bi\s+am\s+(?:an?\s+)?ai\b/i,
  /\bas\s+an?\s+ai\s+(?:language\s+)?model\b/i,
]

function sanitizeForPrompt(input: string, maxLen = 500): string {
  let cleaned = String(input ?? '')
  for (const pat of PROMPT_INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pat, '[redacted]')
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, maxLen)
}

// Catches fabricated percentages — the biggest hallucination class for a prediction-
// market bot. The prompt says "NEVER invent a specific percentage you don't have"
// but at temp 0.8 with no validator, the model will. We extract all %s from the
// output and verify each one appears in the input context (within ±1 for rounding).
// If any output % isn't in context, throw — the post is rejected.
const PCT_RE = /\b(\d{1,3}(?:\.\d+)?)\s*%/g
function checkForFabricatedPercentages(content: string, contextText: string): void {
  const out: number[] = []
  for (const m of content.matchAll(PCT_RE)) out.push(parseFloat(m[1]))
  if (out.length === 0) return

  const ctx: number[] = []
  for (const m of contextText.matchAll(PCT_RE)) ctx.push(parseFloat(m[1]))

  for (const n of out) {
    const matched = ctx.some(c => Math.abs(c - n) <= 1)
    if (!matched) {
      throw new Error(`fabricated percentage in output: ${n}% — not present in input context`)
    }
  }
}

// Catches fabricated stock tickers. Real failure case from the May 5 review:
// the model wrote "$FRMM" in a post when no ticker was in the source. Tickers
// are unambiguous identifiers — if one shows up in the post but not in the
// headline or summary, it was made up. We extract all $XXX-style symbols
// (1-5 uppercase letters, optionally followed by a class suffix like .A) from
// the output and require each to appear in the context. Throws on miss so the
// post is rejected rather than shipped with a fake ticker.
const TICKER_RE = /\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g
function checkForFabricatedTickers(content: string, contextText: string): void {
  const out = new Set<string>()
  for (const m of content.matchAll(TICKER_RE)) out.add(m[1].toUpperCase())
  if (out.size === 0) return

  // Match either "$FOO" / "$BRK.A" or a bare "FOO" capitalized in context (news
  // headlines sometimes write "AAPL" without the dollar sign, e.g. "AAPL beats
  // estimates"). We dedupe on the base symbol (everything before any `.`), so
  // `$BRK.A` in the output matches a bare "BRK" in context.
  const baseOf = (sym: string) => sym.split('.')[0]
  const ctxTickers = new Set<string>()
  for (const m of contextText.matchAll(TICKER_RE)) ctxTickers.add(baseOf(m[1].toUpperCase()))
  const bareCapsRe = /\b([A-Z]{2,5})\b/g
  for (const m of contextText.matchAll(bareCapsRe)) ctxTickers.add(m[1].toUpperCase())

  for (const t of out) {
    if (!ctxTickers.has(baseOf(t))) {
      throw new Error(`fabricated ticker in output: $${t} — not present in input context`)
    }
  }
}

function validateAIResponse(raw: unknown): AIResponse {
  if (typeof raw !== 'object' || raw === null) throw new Error('AI response not an object')
  const r = raw as Record<string, unknown>

  if (r.content_mode !== 'pure_news' && r.content_mode !== 'news_odds' && r.content_mode !== 'engagement') {
    throw new Error(`Invalid content_mode: ${String(r.content_mode)}`)
  }
  const content = r.content
  if (typeof content !== 'string') throw new Error('content not a string')
  if (content.length < 20 || content.length > 400) {
    throw new Error(`content length out of bounds: ${content.length}`)
  }
  for (const banned of BANNED_OUTPUT_PHRASES) {
    if (banned.test(content)) {
      throw new Error(`output contained banned phrase: ${banned.source.slice(0, 60)}`)
    }
  }

  return {
    content_mode: r.content_mode,
    has_market: typeof r.has_market === 'boolean' ? r.has_market : false,
    include_link: typeof r.include_link === 'boolean' ? r.include_link : false,
    content,
    char_count: typeof r.char_count === 'number' ? r.char_count : content.length,
    estimated_score: typeof r.estimated_score === 'number' ? r.estimated_score : 5,
    score_explanation: typeof r.score_explanation === 'string' ? r.score_explanation : '',
  }
}

async function callClaude(cluster: Cluster, marketUrl: string, modeHint?: ContentMode): Promise<AIResponse> {
  const apiKey: string | undefined = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  // Narrowed binding so the inner closure can use it without TS widening back to string|undefined
  const key: string = apiKey
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

  // Sanitize each constituent summary individually (so split-injection across cluster
  // items can't reassemble) then cap the joined total.
  const summaries: string[] = []
  try { summaries.push(...JSON.parse(cluster.constituentSummaries ?? '[]')) } catch {}
  const sanitizedSummaries = summaries.map(s => sanitizeForPrompt(s, 200))
  const summaryText = sanitizedSummaries.join(' ').slice(0, 600)

  const safeHeadline = sanitizeForPrompt(cluster.canonicalHeadline, 240)
  const safeCategory = sanitizeForPrompt(cluster.category, 40)

  const ageMinutes = Math.round((Date.now() - cluster.firstSeenAt) / 60000)
  const modeInstruction = modeHint
    ? `You MUST use content_mode: "${modeHint}".`
    : `Choose the most appropriate content_mode based on the story age, category, and whether a Polymarket market likely exists.`

  const userPrompt = `Category: ${safeCategory}
Age: ${ageMinutes} minutes old
Relevance score: ${(cluster.relevanceScore ?? 0).toFixed(1)}/10

Headline: ${safeHeadline}
Context/Summary: ${summaryText || '(no additional context)'}
Market (reviewer metadata — NEVER put a URL in the tweet): ${marketUrl}

${modeInstruction}

Remember:
- Lead with anticipation, not a news alert. No "BREAKING:" / "JUST IN:" out of habit — frame the outcome that's still up for grabs.
- Never write casualties or gore. For conflict stories, frame the open question neutrally and lean to the de-escalation angle.
- Tasteful emoji ok (0–2). Never name Polymarket or Kalshi ("Probly" is fine). No URLs — a human adds the link.
- pure_news (THE DROP): 1–2 punchy, forward-looking lines, optional hook.
- news_odds (THE LINE): the development + the prediction, qualitative direction only (never invent a %).
- engagement (THE ARC): 3–5 sentences of arc, then one sharp, fun, take-a-side question. ~280–320 characters.

Now write one post.`

  const body = {
    model,
    max_tokens: 600,
    temperature: 0.8,
    system: SIGNALDESK_PROMPT_V1,
    messages: [{ role: 'user', content: userPrompt }],
  }

  async function doFetch(): Promise<Response> {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  // Retry transient failures (rate limits + 5xx) with exponential backoff: 2s, 4s, 8s.
  // 4xx other than 429 fail immediately — they're our error, not theirs.
  const RETRY_DELAYS_MS = [2000, 4000, 8000]
  let res: Response | null = null
  let lastError = ''
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    res = await doFetch()
    if (res.ok) break
    const transient = res.status === 429 || res.status >= 500
    if (!transient) break
    lastError = `${res.status}`
    if (attempt === RETRY_DELAYS_MS.length) break
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
  }
  if (!res || !res.ok) {
    const errBody = res ? await res.text().catch(() => '') : ''
    throw new Error(`Anthropic API error: ${res?.status ?? 'no response'} ${errBody.slice(0, 200)} (last=${lastError})`)
  }

  const data = await res.json() as { content?: Array<{ text?: string }> }
  const raw = data.content?.[0]?.text ?? ''
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch (e) {
    throw new Error(`AI response was not valid JSON: ${(e as Error).message}`)
  }
  const validated = validateAIResponse(parsed)
  checkForFabricatedPercentages(validated.content, userPrompt)
  checkForFabricatedTickers(validated.content, userPrompt)
  return validated
}

// Exported for tests only. Not part of the public API.
export const __testing = {
  checkForFabricatedPercentages,
  checkForFabricatedTickers,
}

export async function generatePost(cluster: Cluster, modeHint?: ContentMode) {
  const marketBaseUrl = process.env.NEXT_PUBLIC_MARKET_BASE_URL ?? 'https://yourplatform.com/markets'
  const marketUrl = `${marketBaseUrl}/${cluster.id}`

  try {
    const result = await callClaude(cluster, marketUrl, modeHint)

    // Force-strip ANY URL from ALL modes — tweets are text-only per marketing
    result.content = result.content.replace(/https?:\/\/\S+/g, '').replace(/\n+$/, '').trim()

    const post = {
      id: crypto.randomUUID(),
      clusterId: cluster.id,
      contentMode: result.content_mode,
      content: result.content,
      marketLink: marketUrl,
      charCount: result.char_count ?? result.content.length,
      estimatedScore: result.estimated_score,
      scoreExplanation: result.score_explanation,
      status: 'pending' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    db.insert(generatedPosts).values(post).run()

    try {
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_generated',
        entityType: 'generated_post',
        entityId: post.id,
        details: JSON.stringify({ clusterId: cluster.id, mode: result.content_mode, hasMarket: result.has_market }),
        createdAt: Date.now(),
      }).run()
    } catch (e) {
      console.error(`audit log write failed (post_generated, post=${post.id}):`, e)
    }

    return db.select().from(generatedPosts).where(eq(generatedPosts.id, post.id)).get()!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'error',
        entityType: 'generated_post',
        entityId: cluster.id,
        errorCode: 'GENERATION_FAILED',
        errorMessage: message,
        createdAt: Date.now(),
      }).run()
    } catch (e) {
      console.error(`audit log write failed (generation error, cluster=${cluster.id}):`, e)
    }
    throw error
  }
}

// Smart generation: high score = 2 posts (pure_news speed + AI-chosen), medium = 1 AI-chosen post
export async function generateSmartPosts(cluster: Cluster) {
  // Daily cap — enforces settings.daily_post_limit so a runaway cron doesn't burn LLM credits.
  const cap = isOverDailyLimit()
  if (cap.over) {
    try {
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'skip',
        entityType: 'event_cluster',
        entityId: cluster.id,
        details: JSON.stringify({ reason: 'daily_limit_reached', count: cap.count, limit: cap.limit }),
        createdAt: Date.now(),
      }).run()
    } catch (e) {
      console.error(`audit log write failed: ${(e as Error).message}`)
    }
    return []
  }

  // HIGH_RISK gate — clusters flagged with riskLevel='high' (death, shooting, bombing, etc.)
  // are NEVER auto-generated. They sit at status='high_risk_skipped' until a human explicitly
  // calls /api/posts/generate with the cluster_id. Stops the bot from auto-writing
  // "what's the Polymarket angle on this tragedy" posts.
  if (cluster.riskLevel === 'high') {
    db.update(eventClusters)
      .set({ status: 'high_risk_skipped', lastUpdatedAt: Date.now() })
      .where(eq(eventClusters.id, cluster.id))
      .run()
    try {
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'skip',
        entityType: 'event_cluster',
        entityId: cluster.id,
        details: JSON.stringify({
          reason: 'high_risk_auto_skip',
          headline: cluster.canonicalHeadline.slice(0, 120),
          riskReasons: cluster.riskReasons,
        }),
        createdAt: Date.now(),
      }).run()
    } catch (e) {
      console.error(`audit log write failed for cluster ${cluster.id}:`, e)
    }
    return []
  }

  // Auto-generation is locked to a single pure_news post per cluster.
  // pure_news = "THE DROP": a crisp, forward-looking, optimistic take on what's
  // in play — the Probly house voice (see prompts.ts). The richer modes
  // (news_odds, engagement) remain available via the manual
  // /api/posts/generate endpoint with an explicit mode override, but the
  // 15-min auto-generate cron always emits pure_news.
  const posts: (typeof generatedPosts.$inferSelect)[] = []
  try {
    const post = await generatePost(cluster, 'pure_news')
    posts.push(post)
  } catch (e) {
    console.error(`Failed to generate post for cluster ${cluster.id}:`, e)
  }

  // Status update — critical for preventing re-pick by the cron candidate query.
  //   posts.length > 0  → 'done'              (success path)
  //   posts.length == 0 → 'generation_failed' (every generatePost threw — usually
  //                       fabricated-% or banned-phrase rejection; previously we
  //                       left status='new' which made the cluster re-qualify
  //                       every 15-min tick forever)
  // Manual retry is still possible by hitting POST /api/posts/generate with
  // the cluster_id explicitly.
  db.update(eventClusters)
    .set({
      postCount: posts.length,
      status: posts.length > 0 ? 'done' : 'generation_failed',
      lastUpdatedAt: Date.now(),
    })
    .where(eq(eventClusters.id, cluster.id))
    .run()

  return posts
}

// Keep for manual "Generate Posts" button — generates 2 posts so reviewer has choice
export async function generateAllModes(cluster: Cluster) {
  return generateSmartPosts(cluster)
}
