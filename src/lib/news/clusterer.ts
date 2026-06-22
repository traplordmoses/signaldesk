import { db } from '@/lib/db'
import { newsItems, eventClusters } from '@/lib/db/schema'
import { eq, and, gt } from 'drizzle-orm'
import { getTier1And2Keywords } from './scorer'
import { extractTopics } from './tagger'

// Word-boundary match — same fix as scorer.ts. .includes() would fire "doj" on
// any string containing those chars; we'd cluster unrelated articles together.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const WORD_RE_CACHE = new Map<string, RegExp>()
function wordBoundaryMatch(text: string, kw: string): boolean {
  let re = WORD_RE_CACHE.get(kw)
  if (!re) {
    re = new RegExp(`(?:^|\\W)${escapeRegex(kw)}(?:$|\\W)`, 'i')
    WORD_RE_CACHE.set(kw, re)
  }
  return re.test(text)
}

// Exported for the scheduler's cross-cycle near-duplicate guard (dedup of
// similar posts within the hour, not just look-alikes inside one cluster batch).
export function extractKeywords(text: string): Set<string> {
  const lower = text.toLowerCase()
  const keywords = getTier1And2Keywords()
  const found = new Set<string>()
  for (const kw of keywords) {
    if (wordBoundaryMatch(lower, kw)) found.add(kw)
  }
  return found
}

export function keywordOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const kw of a) {
    if (b.has(kw)) count++
  }
  return count
}

// Broad stopword list for topical-dedup tokenization. extractKeywords above is
// limited to the curated scoring vocabulary, which has topic words ("world cup")
// but no proper nouns ("Messi", "Argentina") — so two stories about the same
// specific entity shared too few keywords to be caught as duplicates.
const TOPICAL_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'our',
  'your', 'they', 'them', 'we', 'you', 'will', 'would', 'can', 'could', 'has',
  'have', 'had', 'not', 'no', 'new', 'just', 'now', 'out', 'off', 'over', 'into',
  'after', 'before', 'about', 'more', 'than', 'then', 'first', 'last', 'amid',
  'set', 'says', 'said', 'say', 'who', 'what', 'when', 'where', 'why', 'how',
  'which', 'all', 'any', 'some', 'still', 'get', 'got', 'make', 'made', 'via',
  'per', 'vs', 'ahead', 'back', 'one', 'two',
])

/**
 * Significant content tokens for near-duplicate detection — every word ≥3 chars
 * that isn't a stopword (proper nouns included). Paired with an overlap ratio in
 * the scheduler to catch two stories about the same specific entity/event.
 */
export function topicalTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue
    if (TOPICAL_STOPWORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

// Window for merging a freshly-clustered batch into an existing recent cluster
// within the same category. Without this, the same breaking story spawns a new
// cluster every 5-min cron tick: cluster A's items get isProcessed=1, then a
// fresh CNN copy of the same story ingests next tick and has no peers to
// cluster with — so it forms a 1-item cluster of its own. 60 min matches the
// window in which different outlets republish the same breaking event with
// slightly different wordings; after that, follow-up developments are usually
// genuinely new and deserve a fresh card.
const RECENT_MERGE_WINDOW_MS = 60 * 60 * 1000
const MERGE_KEYWORD_OVERLAP_THRESHOLD = 2

// Pure helper for testing the merge eligibility check without a DB.
export function shouldMergeIntoExisting(
  candidateKeywords: Set<string>,
  existingText: string,
): boolean {
  const existingKw = extractKeywords(existingText)
  return keywordOverlap(candidateKeywords, existingKw) >= MERGE_KEYWORD_OVERLAP_THRESHOLD
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
      const now = Date.now()

      // Build the candidate cluster's keyword set from all its items, then check
      // whether an existing recent cluster in the same category covers the same
      // story. If so, merge in instead of creating a duplicate card.
      const candidateKw = new Set<string>()
      for (const it of clusterItems) {
        for (const kw of extractKeywords(it.title + ' ' + (it.summary ?? ''))) {
          candidateKw.add(kw)
        }
      }

      const mergeCutoff = now - RECENT_MERGE_WINDOW_MS
      const recentClusters = db.select()
        .from(eventClusters)
        .where(
          and(
            eq(eventClusters.category, category),
            gt(eventClusters.firstSeenAt, mergeCutoff),
          )
        )
        .all()

      let mergedInto: typeof recentClusters[number] | null = null
      for (const existing of recentClusters) {
        let existingSummaries: string[] = []
        try { existingSummaries = JSON.parse(existing.constituentSummaries ?? '[]') } catch { /* keep [] */ }
        const existingText = existing.canonicalHeadline + ' ' + existingSummaries.join(' ')
        if (shouldMergeIntoExisting(candidateKw, existingText)) {
          mergedInto = existing
          break
        }
      }

      if (mergedInto) {
        let existingIds: string[] = []
        let existingSums: string[] = []
        try { existingIds = JSON.parse(mergedInto.constituentItemIds ?? '[]') } catch { /* keep [] */ }
        try { existingSums = JSON.parse(mergedInto.constituentSummaries ?? '[]') } catch { /* keep [] */ }

        const mergedIds = [...existingIds, ...clusterItems.map(it => it.id)]
        const mergedSums = [...existingSums, ...summaries]
        const mergedScore = Math.max(mergedInto.relevanceScore ?? 0, maxScore)
        const newCanonical = (mergedInto.relevanceScore ?? 0) >= maxScore
          ? mergedInto.canonicalHeadline
          : canonical.title

        db.update(eventClusters)
          .set({
            canonicalHeadline: newCanonical,
            relevanceScore: mergedScore,
            sourceCount: mergedIds.length,
            constituentItemIds: JSON.stringify(mergedIds),
            constituentSummaries: JSON.stringify(mergedSums),
            lastUpdatedAt: now,
          })
          .where(eq(eventClusters.id, mergedInto.id))
          .run()

        for (const item of clusterItems) {
          db.update(newsItems)
            .set({ isProcessed: 1, clusterId: mergedInto.id })
            .where(eq(newsItems.id, item.id))
            .run()
        }

        console.log(`[clusterer] merged ${clusterItems.length} item(s) into existing cluster ${mergedInto.id} (${category})`)
        continue
      }

      const clusterId = crypto.randomUUID()
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
      } catch (e) {
        console.error(`cluster create failed (cluster_id=${clusterId}, items=${clusterItems.length}):`, e)
      }
    }
  }

  return clustersCreated
}
