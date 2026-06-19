import { db } from '@/lib/db'
import { generatedPosts, newsItems } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'
import type { EventCluster, GeneratedPost } from '@/types'
import { reviewContent, type LegalReviewRequest } from './client'

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

// Today every draft is a news post. Placeholder mapping for the platform-event
// + meme post types on Nancy's roadmap (LEGAL_REDLINE_INTEGRATION.md §5).
function postType(contentMode: string): LegalReviewRequest['postType'] {
  if (contentMode === 'engagement') return 'platform_event'
  return 'news'
}

function clusterSourceNames(cluster: EventCluster): string[] {
  const ids = parseJsonArray(cluster.constituentItemIds)
  if (ids.length === 0) return []
  try {
    const rows = db.select({ sourceName: newsItems.sourceName })
      .from(newsItems)
      .where(inArray(newsItems.id, ids.slice(0, 10)))
      .all()
    return [...new Set(rows.map(r => r.sourceName))].slice(0, 5)
  } catch {
    return []
  }
}

function buildRequest(cluster: EventCluster, post: GeneratedPost, sources: string[]): LegalReviewRequest {
  return {
    id: post.id,
    text: post.content,
    postType: postType(post.contentMode),
    context: {
      headline: cluster.canonicalHeadline,
      category: cluster.category,
      topics: parseJsonArray(cluster.topics),
      sources,
      contentMode: post.contentMode,
      marketLink: post.marketLink,
      riskLevel: cluster.riskLevel,
      riskReasons: parseJsonArray(cluster.riskReasons),
    },
  }
}

/**
 * Review each freshly generated draft with the Legal Redline Bot and persist
 * the verdict onto its generated_posts row, so sendClusterToLark renders it on
 * the review card. Per-post fail-open: one failed review never blocks the rest
 * or the send. Called from the scheduler only when LEGAL_REVIEW_ENABLED=1.
 */
export async function reviewClusterPosts(cluster: EventCluster, posts: GeneratedPost[]): Promise<void> {
  const sources = clusterSourceNames(cluster)
  for (const post of posts) {
    try {
      const result = await reviewContent(buildRequest(cluster, post, sources))
      db.update(generatedPosts)
        .set({
          legalVerdict: result.verdict,
          legalRisk: result.risk,
          legalRedline: result.redline,
          legalRationale: result.rationale,
          legalReviewedAt: result.reviewedAt,
        })
        .where(eq(generatedPosts.id, post.id))
        .run()
      console.log(`[legal] ${post.id} → ${result.verdict}/${result.risk}`)
    } catch (e) {
      console.error(`[legal] review failed for post ${post.id}:`, (e as Error).message)
    }
  }
}
