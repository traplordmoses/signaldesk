import Database from 'better-sqlite3'
import { sendClusterToLark } from './src/lib/lark/messages'

async function main() {
  const db = new Database('./data/signaldesk.db')

  // Find clusters that have pending posts but were never sent to Lark
  const clusters = db.prepare(`
    SELECT ec.*
    FROM event_clusters ec
    WHERE ec.post_count > 0
      AND ec.status != 'dismissed'
      AND EXISTS (
        SELECT 1 FROM generated_posts gp
        WHERE gp.cluster_id = ec.id
          AND gp.status = 'pending'
          AND gp.lark_sent_at IS NULL
      )
    ORDER BY ec.relevance_score DESC
    LIMIT 5
  `).all() as any[]

  console.log(`Found ${clusters.length} clusters with unsent posts\n`)

  for (const cluster of clusters) {
    const posts = db.prepare(`
      SELECT * FROM generated_posts
      WHERE cluster_id = ? AND status = 'pending' AND lark_sent_at IS NULL
      ORDER BY created_at DESC
    `).all(cluster.id) as any[]

    if (posts.length === 0) continue

    // Convert snake_case DB rows to camelCase for the Lark function
    const clusterObj = {
      id: cluster.id,
      canonicalHeadline: cluster.canonical_headline,
      category: cluster.category,
      relevanceScore: cluster.relevance_score,
      riskLevel: cluster.risk_level,
      riskReasons: cluster.risk_reasons,
      sourceCount: cluster.source_count,
      constituentItemIds: cluster.constituent_item_ids,
      constituentSummaries: cluster.constituent_summaries,
      status: cluster.status,
      firstSeenAt: cluster.first_seen_at,
      lastUpdatedAt: cluster.last_updated_at,
      postCount: cluster.post_count,
      topics: cluster.topics,
    }

    const postsArr = posts.map((p: any) => ({
      id: p.id,
      clusterId: p.cluster_id,
      contentMode: p.content_mode,
      content: p.content,
      marketLink: p.market_link,
      charCount: p.char_count,
      estimatedScore: p.estimated_score,
      scoreExplanation: p.score_explanation,
      status: p.status,
      rejectionReason: p.rejection_reason,
      postedAt: p.posted_at,
      reviewedBy: p.reviewed_by,
      larkMessageId: p.lark_message_id,
      larkSentAt: p.lark_sent_at,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }))

    try {
      console.log(`Sending: ${cluster.canonical_headline.slice(0, 60)}`)
      const messageId = await sendClusterToLark(clusterObj as any, postsArr as any)

      if (messageId) {
        // Mark posts as sent
        const now = Date.now()
        for (const p of posts) {
          db.prepare('UPDATE generated_posts SET lark_message_id = ?, lark_sent_at = ? WHERE id = ?')
            .run(messageId, now, p.id)
        }
        console.log(`  ✅ Sent! message_id: ${messageId}`)
      }
    } catch (e) {
      console.error(`  ❌ Failed:`, e instanceof Error ? e.message : e)
    }

    // Small delay between messages
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log('\nDone.')
}

main().catch(console.error)
