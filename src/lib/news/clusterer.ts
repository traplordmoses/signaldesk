import { db } from '@/lib/db'
import { newsItems, eventClusters } from '@/lib/db/schema'
import { eq, and, gt } from 'drizzle-orm'
import { getTier1And2Keywords } from './scorer'
import { extractTopics } from './tagger'

function extractKeywords(text: string): Set<string> {
  const lower = text.toLowerCase()
  const keywords = getTier1And2Keywords()
  const found = new Set<string>()
  for (const kw of keywords) {
    if (lower.includes(kw)) found.add(kw)
  }
  return found
}

function keywordOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const kw of a) {
    if (b.has(kw)) count++
  }
  return count
}

export async function clusterNewItems(): Promise<number> {
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000

  const unprocessed = db.select()
    .from(newsItems)
    .where(
      and(
        eq(newsItems.isProcessed, 0),
        gt(newsItems.publishedAt, fourHoursAgo)
      )
    )
    .all()

  if (unprocessed.length === 0) return 0

  // Group by category first
  const byCategory = new Map<string, typeof unprocessed>()
  for (const item of unprocessed) {
    const cat = item.category
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(item)
  }

  let clustersCreated = 0

  for (const [category, items] of byCategory) {
    // Build keyword sets
    const kwSets = items.map(item => ({
      item,
      keywords: extractKeywords(item.title + ' ' + (item.summary ?? '')),
    }))

    const assigned = new Set<string>()

    for (let i = 0; i < kwSets.length; i++) {
      if (assigned.has(kwSets[i].item.id)) continue

      const clusterItems = [kwSets[i].item]
      assigned.add(kwSets[i].item.id)

      for (let j = i + 1; j < kwSets.length; j++) {
        if (assigned.has(kwSets[j].item.id)) continue

        // Must be within 4 hours of each other
        const timeDiff = Math.abs(kwSets[i].item.publishedAt - kwSets[j].item.publishedAt)
        if (timeDiff > 4 * 60 * 60 * 1000) continue

        // Must share 2+ tier1/tier2 keywords
        const overlap = keywordOverlap(kwSets[i].keywords, kwSets[j].keywords)
        if (overlap >= 2) {
          clusterItems.push(kwSets[j].item)
          assigned.add(kwSets[j].item.id)
        }
      }

      // Pick canonical headline = highest scoring item
      const canonical = clusterItems.reduce((best, cur) =>
        (cur.relevanceScore ?? 0) > (best.relevanceScore ?? 0) ? cur : best
      )

      const maxScore = canonical.relevanceScore ?? 0
      const riskLevels = clusterItems.map(it => it.riskLevel ?? 'low')
      const riskLevel = riskLevels.includes('high') ? 'high'
        : riskLevels.includes('medium') ? 'medium'
        : 'low'

      const allReasons = clusterItems.flatMap(it => {
        try { return JSON.parse(it.riskReasons ?? '[]') } catch { return [] }
      })
      const uniqueReasons = [...new Set(allReasons)]

      const summaries = clusterItems.map(it => it.summary ?? '').filter(Boolean)
      const topics = extractTopics(canonical.title, summaries.join(' '))
      const clusterId = crypto.randomUUID()
      const now = Date.now()

      try {
        db.insert(eventClusters).values({
          id: clusterId,
          canonicalHeadline: canonical.title,
          category,
          relevanceScore: maxScore,
          riskLevel,
          riskReasons: JSON.stringify(uniqueReasons),
          sourceCount: clusterItems.length,
          constituentItemIds: JSON.stringify(clusterItems.map(it => it.id)),
          constituentSummaries: JSON.stringify(summaries),
          topics: JSON.stringify(topics),
          status: 'new',
          firstSeenAt: now,
          lastUpdatedAt: now,
          postCount: 0,
        }).run()

        // Mark items as processed
        for (const item of clusterItems) {
          db.update(newsItems)
            .set({ isProcessed: 1, clusterId })
            .where(eq(newsItems.id, item.id))
            .run()
        }

        clustersCreated++
      } catch {}
    }
  }

  return clustersCreated
}
