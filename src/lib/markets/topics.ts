/**
 * LLM-based topic extraction for prediction-market questions.
 *
 * Each market question is run through Claude Haiku once to extract a
 * canonical topic + entity list, which we then keyword-match against news
 * headlines. The result is cached in the `market_topics` table — the same
 * market's topic doesn't change, so re-extraction only happens for markets
 * we haven't seen before.
 *
 * Cost discipline: ~50-100 markets per refresh, but only NEW markets call
 * the LLM. Steady-state cost is ~$0.001 per refresh once the cache is warm.
 */

import { db } from '../db'
import { marketTopics } from '../db/schema'
import { eq } from 'drizzle-orm'
import type { RawMarket as PolyMarket } from './polymarket'
import type { RawMarket as KalshiMarket } from './kalshi'

type RawMarket = PolyMarket | KalshiMarket

// Calls the Anthropic API via raw fetch — same pattern as ai/generator.ts.
// Avoids the SDK dependency so the bundle stays slim.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'

const TOPIC_PROMPT = `You extract canonical topics and matchable entities from prediction-market questions.

Given a market question, return ONE JSON object:
{
  "topic": "short canonical topic name (3-6 words)",
  "entities": ["array", "of", "matchable", "keywords/phrases"],
  "category": "one of: economics | politics | crypto | sports | culture | science | other"
}

Rules for entities:
- Include all proper nouns (people, places, organizations, tickers, contracts).
- Include the canonical short name AND common variants when they exist (ECB, "European Central Bank"; Fed, "Federal Reserve"; BTC, Bitcoin).
- Include the action/event word when it's specific (rate cut, indictment, ceasefire, recession, ETF approval, delisting).
- Lowercase, single words or 2-3 word phrases. No articles (the/a/an).
- 3-8 entities max.
- Skip stopwords and generic words like "will", "by", "happen", "win", "lose".

Examples:
Question: "Will the ECB cut rates by 50bp by end of 2026?"
{
  "topic": "ECB rate decision 2026",
  "entities": ["ecb", "european central bank", "rate cut", "interest rate", "monetary policy", "2026"],
  "category": "economics"
}

Question: "Will Bitcoin hit $150k by June 30, 2026?"
{
  "topic": "Bitcoin price target",
  "entities": ["bitcoin", "btc", "price target", "$150k"],
  "category": "crypto"
}

Question: "US x Iran ceasefire extended by April 22, 2026?"
{
  "topic": "US Iran ceasefire",
  "entities": ["iran", "ceasefire", "us iran", "middle east"],
  "category": "politics"
}

Output JSON only, no preamble, no markdown.`

interface ExtractedTopic {
  topic: string
  entities: string[]
  category: string
}

function isExtractedTopic(v: unknown): v is ExtractedTopic {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.topic === 'string'
    && Array.isArray(o.entities)
    && o.entities.every(e => typeof e === 'string')
    && typeof o.category === 'string'
}

/**
 * Extract topic via LLM. Caller is responsible for caching — this always
 * makes the API call.
 */
async function extractTopic(question: string): Promise<ExtractedTopic | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[markets] ANTHROPIC_API_KEY not set — skipping topic extraction')
    return null
  }
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: TOPIC_PROMPT,
        messages: [{ role: 'user', content: question }],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[markets] topic extraction HTTP ${res.status}: ${body.slice(0, 200)}`)
      return null
    }
    const data = await res.json() as { content?: Array<{ type?: string; text?: string }> }
    const block = data.content?.[0]
    if (!block || block.type !== 'text' || !block.text) return null
    const cleaned = block.text.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
    const parsed: unknown = JSON.parse(cleaned)
    if (!isExtractedTopic(parsed)) return null
    // Normalize entities to lowercase, strip empties.
    parsed.entities = parsed.entities
      .map(e => e.toLowerCase().trim())
      .filter(e => e.length > 1)
    return parsed
  } catch (e) {
    console.warn(`[markets] topic extraction failed for "${question.slice(0, 60)}": ${(e as Error).message}`)
    return null
  }
}

/**
 * Upsert a market's topics. If a row already exists for this market id we
 * skip the LLM call (extracted topics for the same market don't change),
 * just bumping `last_seen_at` and refreshing `volume_24h`.
 */
export async function upsertMarketTopic(market: RawMarket): Promise<void> {
  const id = `${market.source}:${market.marketId}`
  const now = Date.now()

  const existing = db.select().from(marketTopics).where(eq(marketTopics.id, id)).get()
  if (existing) {
    // Just refresh volume + last seen — topic stays cached.
    db.update(marketTopics)
      .set({ volume24h: market.volume24h, lastSeenAt: now, question: market.question })
      .where(eq(marketTopics.id, id))
      .run()
    return
  }

  const extracted = await extractTopic(market.question)
  db.insert(marketTopics).values({
    id,
    source: market.source,
    marketId: market.marketId,
    question: market.question,
    volume24h: market.volume24h,
    topic: extracted?.topic ?? null,
    entities: extracted ? JSON.stringify(extracted.entities) : null,
    category: extracted?.category ?? null,
    extractedAt: now,
    lastSeenAt: now,
  }).run()
}
