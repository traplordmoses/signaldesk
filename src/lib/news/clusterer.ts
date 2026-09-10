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


// ── Same-story detection ────────────────────────────────────────────────────
//
// The curated-keyword rule below (2+ shared TIER1/TIER2 keywords) misses the
// common case entirely: one story covered by many outlets. "Anthropic says it
// blocked bioweapons research" shares exactly ONE curated keyword ('anthropic')
// with its own coverage, so eight outlets produced eight separate cards.
//
// Plain token overlap can't fix it on its own, because it cannot tell "same
// event, different wording" from "same template, different entities" — "Trump
// tariffs on Chinese steel" and "Trump tariffs on Mexican avocado" share four
// tokens and are different stories. Two signals do separate them:
//
//   1. DISTINCTIVENESS. Weight shared tokens by how rare they are in the current
//      batch. Measured on live production data: 'anthropic' appeared in 15% of a
//      365-item batch and 'openai' in 12%, so sharing those means little, while
//      'biological' (3%) and 'bioweapons' (1%) genuinely pin down one story.
//   2. ENTITY DIVERGENCE. If each headline names a proper noun the other does
//      not, they are about different subjects however much boilerplate they
//      share. This is what rejects the tariff and football-scoreline traps.
//
// Calibrated against a real batch: 59/105 true pairs merge, 0/120 false pairs,
// and all three template traps are rejected. Single-linkage below turns those
// 59 edges into one component.

// Shared tokens rarer than this share of the batch count as distinctive.
const DISTINCTIVE_DF_RATIO = 0.08
const MIN_DISTINCTIVE_SHARED = 2
const MIN_OVERLAP_COEF = 0.25

// Capitalised words that carry no entity signal.
const CAP_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'but', 'for', 'of', 'in', 'on', 'at', 'to', 'with',
  'from', 'by', 'as', 'is', 'are', 'it', 'its', 'this', 'that', 'new', 'how',
  'why', 'what', 'when', 'says', 'said', 'after', 'over', 'his', 'her', 'their',
])

/**
 * Proper-noun proxy: capitalised words that aren't sentence-initial.
 *
 * Returns EMPTY for predominantly Title Case headlines, where capitalisation
 * carries no information — better to fall back to token overlap alone than to
 * treat every word as an entity. Parenthetical attributions are stripped first
 * because Techmeme appends "(Dustin Volz/New York Times)" to its titles.
 *
 * The FIRST word counts. Sentence-initial capitalisation is automatic, so it is
 * weak evidence, but news headlines lead with their subject far more often than
 * not ("Anthropic says…", "Trump announces…"). Excluding it meant "Anthropic
 * blocks X" and "OpenAI blocks X" showed no entity divergence at all and could
 * merge into one cluster. Common leading words are handled by CAP_STOPWORDS.
 */
export function properNouns(text: string): Set<string> {
  const words = text.replace(/\([^)]*\)/g, ' ').split(/[^A-Za-z0-9\u2019']+/).filter(Boolean)
  if (words.length < 3) return new Set()

  // Title Case is judged on words AFTER the first. The leading word is
  // capitalised in every style, so counting it as evidence of Title Case wrongly
  // flags short sentence-case headlines and switches the entity guard off.
  const rest = words.slice(1)
  const cappedRest = rest.filter(w => /^[A-Z]/.test(w))
  if (rest.length > 0 && cappedRest.length / rest.length > 0.6) return new Set()

  const capped = words.filter(w => /^[A-Z]/.test(w))
  return new Set(capped.map(w => w.toLowerCase()).filter(w => !CAP_STOPWORDS.has(w)))
}

/** Token -> number of texts containing it. */
export function buildDocFrequency(texts: string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const t of texts) {
    for (const tok of topicalTokens(t)) df.set(tok, (df.get(tok) ?? 0) + 1)
  }
  return df
}

/**
 * Do these two texts describe the same event? See the block comment above for
 * why both signals are needed. `dfMax` is the distinctiveness cutoff, derived
 * from the batch size by the caller.
 */
export function sameStory(
  a: string,
  b: string,
  df: Map<string, number>,
  dfMax: number,
): boolean {
  const A = topicalTokens(a)
  const B = topicalTokens(b)
  if (A.size === 0 || B.size === 0) return false

  let shared = 0
  let distinctiveShared = 0
  for (const tok of A) {
    if (!B.has(tok)) continue
    shared++
    if ((df.get(tok) ?? 1) <= dfMax) distinctiveShared++
  }
  if (distinctiveShared < MIN_DISTINCTIVE_SHARED) return false
  if (shared / Math.min(A.size, B.size) < MIN_OVERLAP_COEF) return false

  // Entity divergence: each side naming a proper noun the other lacks means
  // different subjects, however much phrasing they share.
  const pa = properNouns(a)
  const pb = properNouns(b)
  if (pa.size > 0 && pb.size > 0) {
    let aOnly = false
    let bOnly = false
    for (const w of pa) if (!pb.has(w)) { aOnly = true; break }
    for (const w of pb) if (!pa.has(w)) { bOnly = true; break }
    if (aOnly && bOnly) return false
  }
  return true
}

export function distinctivenessCutoff(batchSize: number): number {
  return Math.max(3, Math.round(batchSize * DISTINCTIVE_DF_RATIO))
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

  // NOT partitioned by source category any more. Category here is the FEED's
  // desk, not the story's subject, so the same event covered by Politico and by
  // TechCrunch landed in different partitions and could never merge — which is
  // exactly what happened to the Anthropic bioweapons story. Story identity
  // should not depend on whose desk covered it. The cluster takes its category
  // from its canonical (highest-scoring) item instead.
  const groups: [string, typeof unprocessed][] = [['all', unprocessed]]

  // Distinctiveness is measured against THIS batch, so the cutoff adapts to what
  // is ambient right now: during a wave of AI coverage 'anthropic' stops being
  // a useful signal on its own, while 'bioweapons' still pins down one story.
  const df = buildDocFrequency(unprocessed.map(it => it.title + ' ' + (it.summary ?? '')))
  const dfMax = distinctivenessCutoff(unprocessed.length)

  let clustersCreated = 0

  for (const [, items] of groups) {
    // Build keyword sets
    const kwSets = items.map(item => ({
      item,
      keywords: extractKeywords(item.title + ' ' + (item.summary ?? '')),
      text: item.title + ' ' + (item.summary ?? ''),
    }))

    const assigned = new Set<string>()

    for (let i = 0; i < kwSets.length; i++) {
      if (assigned.has(kwSets[i].item.id)) continue

      const clusterItems = [kwSets[i].item]
      const clusterTexts = [kwSets[i].text]
      assigned.add(kwSets[i].item.id)

      for (let j = i + 1; j < kwSets.length; j++) {
        if (assigned.has(kwSets[j].item.id)) continue

        // Must be within 4 hours of each other
        const timeDiff = Math.abs(kwSets[i].item.publishedAt - kwSets[j].item.publishedAt)
        if (timeDiff > 4 * 60 * 60 * 1000) continue

        // MAJORITY linkage: join only if this matches at least half the members
        // already in the cluster.
        //
        // Single linkage (match ANY member) chains: A-B and B-C pull C in even
        // when A and C are unrelated. In production that put "OpenAI pauses Pro
        // subscriptions" and "OpenAI's Astra model" inside the "ChatGPT for
        // Financial Services" cluster, and T. Rowe Price inside Anthropic's
        // threat report — those stories then lose their own card entirely.
        // Measured on a real batch, on-topic share of the finance cluster:
        // single 11/17, seed-only 10/12, majority 9/9, with identical
        // consolidation of the duplicate story (3 clusters in every mode).
        const curated = keywordOverlap(kwSets[i].keywords, kwSets[j].keywords) >= 2
        let linked = curated
        if (!linked) {
          let hits = 0
          for (const t of clusterTexts) {
            if (sameStory(t, kwSets[j].text, df, dfMax)) hits++
          }
          linked = hits > 0 && hits >= Math.ceil(clusterTexts.length / 2)
        }
        if (linked) {
          clusterItems.push(kwSets[j].item)
          clusterTexts.push(kwSets[j].text)
          assigned.add(kwSets[j].item.id)
        }
      }

      // Pick canonical headline = highest scoring item
      const canonical = clusterItems.reduce((best, cur) =>
        (cur.relevanceScore ?? 0) > (best.relevanceScore ?? 0) ? cur : best
      )

      const category = canonical.category
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

      // Same reasoning as above: no category filter. A tech-desk copy of a story
      // must be able to merge into the politics-desk cluster that already exists.
      const mergeCutoff = now - RECENT_MERGE_WINDOW_MS
      const recentClusters = db.select()
        .from(eventClusters)
        .where(gt(eventClusters.firstSeenAt, mergeCutoff))
        .all()

      let mergedInto: typeof recentClusters[number] | null = null
      for (const existing of recentClusters) {
        let existingSummaries: string[] = []
        try { existingSummaries = JSON.parse(existing.constituentSummaries ?? '[]') } catch { /* keep [] */ }
        const existingText = existing.canonicalHeadline + ' ' + existingSummaries.join(' ')

        // The same-story test compares HEADLINE to HEADLINE, not the candidate's
        // accumulated text against the cluster's accumulated text. Concatenating
        // everything makes a big cluster a magnet: the more items it absorbs the
        // more tokens it offers, so the easier it is for anything to match, and
        // it grows without bound. Production showed exactly that — one Anthropic
        // cluster reached 16 items and had pulled in T. Rowe Price. Anchoring on
        // the canonical headline keeps the test on what the cluster is ABOUT,
        // and matches the headline-to-headline data the thresholds were tuned on.
        if (
          shouldMergeIntoExisting(candidateKw, existingText) ||
          sameStory(canonical.title, existing.canonicalHeadline, df, dfMax)
        ) {
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
