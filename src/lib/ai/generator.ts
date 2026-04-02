import { db } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { SIGNALDESK_PROMPT_V1 } from './prompts'

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

async function callTogetherAI(cluster: Cluster, marketUrl: string, modeHint?: ContentMode): Promise<AIResponse> {
  const apiKey = process.env.TOGETHER_API_KEY
  if (!apiKey) throw new Error('TOGETHER_API_KEY not set')

  const summaries: string[] = []
  try { summaries.push(...JSON.parse(cluster.constituentSummaries ?? '[]')) } catch {}
  const summaryText = summaries.join(' ').slice(0, 600)

  const ageMinutes = Math.round((Date.now() - cluster.firstSeenAt) / 60000)
  const modeInstruction = modeHint
    ? `You MUST use content_mode: "${modeHint}".`
    : `Choose the most appropriate content_mode based on the story age, category, and whether a Polymarket market likely exists.`

  const userPrompt = `Category: ${cluster.category}
Age: ${ageMinutes} minutes old
Relevance score: ${(cluster.relevanceScore ?? 0).toFixed(1)}/10

Headline: ${cluster.canonicalHeadline}
Context/Summary: ${summaryText || '(no additional context)'}
Market URL (use ONLY for news_odds and engagement modes, NOT for pure_news): ${marketUrl}

${modeInstruction}

Remember:
- pure_news: NO market URL in the content. Just the breaking fact.
- news_odds: include real probability movement if context has it, else describe direction. Market URL on last line.
- engagement: 3-5 sentences of context + trajectory + what's at stake + who wins/loses, then one sharp forced-choice question. Market URL on last line. AIM FOR 280-320 characters — longer is better here.

Now write one post.`

  const body = {
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    messages: [
      { role: 'system', content: SIGNALDESK_PROMPT_V1 },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 600,
    temperature: 0.8,
  }

  async function doFetch(): Promise<Response> {
    return fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  let res = await doFetch()
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2000))
    res = await doFetch()
  }
  if (!res.ok) throw new Error(`Together AI error: ${res.status}`)

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content ?? ''
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
  return JSON.parse(cleaned) as AIResponse
}

export async function generatePost(cluster: Cluster, modeHint?: ContentMode) {
  const marketBaseUrl = process.env.NEXT_PUBLIC_MARKET_BASE_URL ?? 'https://yourplatform.com/markets'
  const marketUrl = `${marketBaseUrl}/${cluster.id}`

  try {
    const result = await callTogetherAI(cluster, marketUrl, modeHint)

    // Force-strip any URL from pure_news — AI sometimes ignores the instruction
    if (result.content_mode === 'pure_news') {
      result.content = result.content.replace(/https?:\/\/\S+/g, '').replace(/\n+$/, '').trim()
    }

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
    } catch {}

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
    } catch {}
    throw error
  }
}

// Smart generation: high score = 2 posts (pure_news speed + AI-chosen), medium = 1 AI-chosen post
export async function generateSmartPosts(cluster: Cluster) {
  const score = cluster.relevanceScore ?? 0
  const posts: (typeof generatedPosts.$inferSelect)[] = []

  if (score >= 8) {
    // Very high priority: generate pure_news (speed) + AI-chosen best mode
    for (const hint of ['pure_news', undefined] as (ContentMode | undefined)[]) {
      try {
        const post = await generatePost(cluster, hint)
        // Avoid duplicate modes
        if (!posts.find(p => p.contentMode === post.contentMode)) {
          posts.push(post)
        }
      } catch (e) {
        console.error(`Failed to generate post for cluster ${cluster.id}:`, e)
      }
    }
  } else {
    // Medium priority: 1 AI-chosen post
    try {
      const post = await generatePost(cluster)
      posts.push(post)
    } catch (e) {
      console.error(`Failed to generate post for cluster ${cluster.id}:`, e)
    }
  }

  // Legacy: also export generateAllModes for manual generation from UI (generates up to 2)
  db.update(eventClusters)
    .set({ postCount: posts.length, status: posts.length > 0 ? 'done' : 'new', lastUpdatedAt: Date.now() })
    .where(eq(eventClusters.id, cluster.id))
    .run()

  return posts
}

// Keep for manual "Generate Posts" button — generates 2 posts so reviewer has choice
export async function generateAllModes(cluster: Cluster) {
  return generateSmartPosts(cluster)
}
