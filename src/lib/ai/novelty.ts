/**
 * Catchiness: how surprising or shareable a headline is.
 *
 * The team wants the "random, unique, catchy" stories Polymarket posts — "US
 * military acknowledges for the first time it has deployed weapons in orbit", or
 * a man accused of plotting an attack turning out to moderate r/DoorDash. The
 * scorer can't see that quality: it rewards category keywords and market fit,
 * so the space story scored 4.50 and the DoorDash story ~1.5 against a 6.5 gate.
 * Keyword rules can't recognise absurdity either. A model can.
 *
 * Applied when a cluster is CREATED, not at selection, because the candidate
 * query filters on relevance >= 6.5 before selection ever runs — a story at 1.5
 * would never become a candidate for a selection-time bonus to help.
 *
 * Batched per clustering tick and cached per cluster, so each headline is rated
 * once. ~2,000 new clusters a day at 40 per call is a few dollars a month.
 * Fail-safe: any error means no boost, never a failed clustering run.
 */
import { sqlite } from '@/lib/db'

export const CLUSTER_NOVELTY_DDL = `
  CREATE TABLE IF NOT EXISTS cluster_novelty (
    cluster_id TEXT PRIMARY KEY,
    score      REAL NOT NULL,
    scored_at  INTEGER NOT NULL
  )`

const BATCH = 40
const TIMEOUT_MS = 30_000
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

const NOVELTY_PROMPT = `You rate news headlines for how surprising, unusual or shareable they are to a general audience on X.

Score each 0-10:
10   genuinely bizarre, a first-of-its-kind reveal, or a detail people will screenshot and share.
     e.g. a man accused of plotting an ISIS-inspired attack turns out to moderate the r/DoorDash subreddit;
     the US military publicly acknowledges for the first time that it has deployed weapons in orbit.
7-9  a real surprise: an unexpected reversal, a genuine first, a strange detail, a big name doing something odd.
4-6  notable, but the kind of thing that happens.
0-3  routine: scores, fixtures, results, earnings, schedules, previews, "how to watch", listicles, fantasy picks, betting tips, opinion, analysis.

Judge the headline as a reader would. Rare is not the same as important: a routine central-bank decision is important and scores low; a bizarre detail in a minor story scores high.

Return ONLY JSON: {"scores":[{"id":0,"score":7}]}`

/**
 * Relevance points for a novelty rating. Zero up to 5, then steep, so only
 * genuinely unusual stories are lifted from nothing: a 9 adds +5, which is what a
 * category-less, market-less story at ~1.5 needs to reach the 6.5 gate.
 */
export function noveltyBoost(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(10, score) - 5) * 1.25
}

/** Selection-time preference among candidates that already cleared the gate. */
export const NOVELTY_SELECTION_THRESHOLD = 8

async function rateBatch(items: { id: number; headline: string }[]): Promise<Map<number, number>> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        temperature: 0,
        system: NOVELTY_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(items) }],
      }),
    })
    if (!res.ok) throw new Error(`novelty HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const data = await res.json() as { content?: Array<{ text?: string }> }
    const raw = (data.content?.[0]?.text ?? '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const parsed = JSON.parse(raw) as { scores?: Array<{ id: number; score: number }> }
    const out = new Map<number, number>()
    for (const s of parsed.scores ?? []) {
      if (typeof s.id === 'number' && typeof s.score === 'number' && s.score >= 0 && s.score <= 10) {
        out.set(s.id, s.score)
      }
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Rate newly created clusters and lift their relevance by the novelty boost.
 * Returns how many were rated. Never throws.
 */
export async function applyNovelty(
  clusters: { id: string; headline: string; baseScore: number }[],
): Promise<{ rated: number; lifted: number; errors: string[] }> {
  const errors: string[] = []
  if (clusters.length === 0) return { rated: 0, lifted: 0, errors }
  try { sqlite.exec(CLUSTER_NOVELTY_DDL) } catch (e) { return { rated: 0, lifted: 0, errors: [(e as Error).message] } }

  const record = sqlite.prepare('INSERT OR REPLACE INTO cluster_novelty (cluster_id, score, scored_at) VALUES (?, ?, ?)')
  const lift = sqlite.prepare('UPDATE event_clusters SET relevance_score = ? WHERE id = ?')
  let rated = 0
  let lifted = 0

  for (let i = 0; i < clusters.length; i += BATCH) {
    const batch = clusters.slice(i, i + BATCH)
    try {
      const scores = await rateBatch(batch.map((c, id) => ({ id, headline: c.headline })))
      const now = Date.now()
      batch.forEach((c, id) => {
        const score = scores.get(id)
        if (score == null) return
        record.run(c.id, score, now)
        rated++
        const boost = noveltyBoost(score)
        if (boost > 0) {
          lift.run(Math.min(10, c.baseScore + boost), c.id)
          lifted++
        }
      })
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  return { rated, lifted, errors }
}

/** Stored novelty for clusters, for the selection-time preference. */
export function noveltyFor(clusterIds: string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (clusterIds.length === 0) return out
  try {
    sqlite.exec(CLUSTER_NOVELTY_DDL)
    const rows = sqlite.prepare(
      `SELECT cluster_id, score FROM cluster_novelty WHERE cluster_id IN (${clusterIds.map(() => '?').join(',')})`,
    ).all(...clusterIds) as { cluster_id: string; score: number }[]
    for (const r of rows) out.set(r.cluster_id, r.score)
  } catch { /* table missing: no preference */ }
  return out
}
