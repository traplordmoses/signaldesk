/**
 * Approval-driven feedback — turns the team's Approve/Reject signal (already in
 * generated_posts.status) into two gentle, no-ML improvements:
 *
 *   1. getApprovedExamples()        → recently-approved posts become live few-shot
 *      examples in the generation prompt, so the bot writes more like what passed
 *      human review.
 *   2. recomputeSourceWeightBonus() → nudges each source's score weight by its
 *      approval rate, bounded and gated on a minimum sample so a thin first week
 *      can't cause wild swings.
 *
 * Source base weight stays in news_sources.weight (seed-managed); the feedback
 * writes a SEPARATE news_sources.weight_bonus so the two never fight. The fetcher
 * scores with weight + weight_bonus.
 */
import { db, sqlite } from './db'
import { newsSources } from './db/schema'
import { eq } from 'drizzle-orm'

// ── 1. Approved posts as few-shot examples ──────────────────────────────────
const EXAMPLE_LIMIT = 8
const EXAMPLE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000  // 60 days
export const MIN_EXAMPLES = 3  // below this we just use the static prompt — no thin-data noise

/**
 * The most recently approved/posted drafts, newest first. Used by the generator
 * to reinforce the house style with the team's own picks.
 */
export function getApprovedExamples(limit = EXAMPLE_LIMIT): string[] {
  const since = Date.now() - EXAMPLE_MAX_AGE_MS
  const rows = sqlite.prepare(
    `SELECT content FROM generated_posts
     WHERE status IN ('approved','posted') AND updated_at >= ?
     ORDER BY updated_at DESC LIMIT ?`
  ).all(since, limit) as { content: string }[]
  return rows
    .map(r => (r.content ?? '').replace(/\s+/g, ' ').trim())
    .filter(c => c.length >= 20 && c.length <= 400)
}

// ── 2. Source weight-bonus feedback ─────────────────────────────────────────
const FEEDBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
const MIN_REVIEWS = 8    // reviewed posts touching a source before we act on it
const BONUS_MAX = 2.0    // clamp the nudge to ±2 (gentle — weight only drives a small score bonus)

/**
 * Recompute every source's weight_bonus from the last 30 days of Approve/Reject
 * decisions. Sources with < MIN_REVIEWS reviews go to neutral (0); the rest get
 * a bonus in [-2, +2] proportional to how far their approval rate is from 50%.
 * Idempotent — safe to run on every boot + on a daily cron.
 */
export function recomputeSourceWeightBonus(): { adjusted: number; sampled: number } {
  const since = Date.now() - FEEDBACK_WINDOW_MS
  const reviewed = sqlite.prepare(
    `SELECT gp.status AS status, ec.constituent_item_ids AS itemIds
     FROM generated_posts gp JOIN event_clusters ec ON ec.id = gp.cluster_id
     WHERE gp.status IN ('approved','posted','rejected') AND gp.created_at >= ?`
  ).all(since) as { status: string; itemIds: string | null }[]

  // Credit every source that contributed an item to a reviewed cluster.
  const tally = new Map<string, { a: number; t: number }>()
  for (const r of reviewed) {
    let ids: string[] = []
    try { ids = JSON.parse(r.itemIds ?? '[]') } catch { continue }
    if (ids.length === 0) continue
    const srcs = sqlite
      .prepare(`SELECT DISTINCT source_id FROM news_items WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { source_id: string }[]
    const approved = r.status === 'approved' || r.status === 'posted'
    for (const { source_id } of srcs) {
      const e = tally.get(source_id) ?? { a: 0, t: 0 }
      e.t++; if (approved) e.a++
      tally.set(source_id, e)
    }
  }

  const allSources = db.select({ id: newsSources.id }).from(newsSources).all()
  let adjusted = 0
  let sampled = 0
  const apply = sqlite.transaction(() => {
    for (const { id } of allSources) {
      const e = tally.get(id)
      let bonus = 0
      if (e && e.t >= MIN_REVIEWS) {
        sampled++
        const rate = e.a / e.t
        // rate 0 → -2, 0.5 → 0, 1.0 → +2  (one decimal)
        bonus = Math.round(Math.max(-BONUS_MAX, Math.min(BONUS_MAX, (rate - 0.5) * 4)) * 10) / 10
        if (bonus !== 0) adjusted++
      }
      db.update(newsSources).set({ weightBonus: bonus }).where(eq(newsSources.id, id)).run()
    }
  })
  apply()
  return { adjusted, sampled }
}
