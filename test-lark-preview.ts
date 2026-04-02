import { sendClusterToLark } from './src/lib/lark/messages'
import Database from 'better-sqlite3'

async function main() {
  const rawDb = new Database('./data/signaldesk.db')

  const cluster = rawDb.prepare(`
    SELECT * FROM event_clusters WHERE post_count > 0 ORDER BY last_updated_at DESC LIMIT 1
  `).get() as any

  const posts = rawDb.prepare(`
    SELECT * FROM generated_posts WHERE cluster_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 3
  `).all(cluster.id) as any[]

  if (posts.length === 0) {
    console.log('No pending posts found, using approved ones')
    const approved = rawDb.prepare(`
      SELECT * FROM generated_posts WHERE cluster_id = ? ORDER BY created_at DESC LIMIT 3
    `).all(cluster.id) as any[]
    posts.push(...approved)
  }

  // Convert snake_case to camelCase
  const c = {
    id: cluster.id, canonicalHeadline: cluster.canonical_headline,
    category: cluster.category, relevanceScore: cluster.relevance_score,
    riskLevel: cluster.risk_level, riskReasons: cluster.risk_reasons,
    sourceCount: cluster.source_count, constituentItemIds: cluster.constituent_item_ids,
    constituentSummaries: cluster.constituent_summaries, status: cluster.status,
    firstSeenAt: cluster.first_seen_at, lastUpdatedAt: cluster.last_updated_at,
    postCount: cluster.post_count, topics: cluster.topics,
  }
  const ps = posts.map((p: any) => ({
    id: p.id, clusterId: p.cluster_id, contentMode: p.content_mode,
    content: p.content, marketLink: p.market_link, charCount: p.char_count,
    estimatedScore: p.estimated_score, scoreExplanation: p.score_explanation,
    status: p.status, rejectionReason: p.rejection_reason, postedAt: p.posted_at,
    reviewedBy: p.reviewed_by, larkMessageId: p.lark_message_id, larkSentAt: p.lark_sent_at,
    createdAt: p.created_at, updatedAt: p.updated_at,
  }))

  console.log(`Sending preview for: ${cluster.canonical_headline.slice(0, 60)}`)
  console.log(`Posts: ${ps.map((p: any) => p.contentMode).join(', ')}`)

  const msgId = await sendClusterToLark(c as any, ps as any)
  console.log(msgId ? `✅ Sent! ${msgId}` : '❌ Failed')
}

main().catch(console.error)
