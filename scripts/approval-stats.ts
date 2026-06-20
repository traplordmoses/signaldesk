/**
 * Approval analytics — what reviewers actually approve vs reject, so we can tune
 * scraping/scoring toward the good stuff. Read-only. Run on the box that has the
 * real review history (the droplet), e.g.:
 *
 *   DB_PATH=/var/lib/signaldesk/signaldesk.db npx tsx scripts/approval-stats.ts [days=30]
 */
import { sqlite } from '../src/lib/db'

const days = Number(process.argv[2] ?? 30)
const since = Date.now() - days * 24 * 60 * 60 * 1000

interface Row { status: string; category: string; score: number | null; mode: string; itemIds: string | null }
const rows = sqlite.prepare(`
  SELECT gp.status AS status, ec.category AS category, ec.relevance_score AS score,
         gp.content_mode AS mode, ec.constituent_item_ids AS itemIds
  FROM generated_posts gp JOIN event_clusters ec ON ec.id = gp.cluster_id
  WHERE gp.status IN ('approved','posted','rejected') AND gp.created_at >= ?
`).all(since) as Row[]

const approvedStatus = (s: string) => s === 'approved' || s === 'posted'

if (rows.length === 0) {
  console.log(`No reviewed posts in the last ${days}d (status approved/posted/rejected).`)
  console.log(`This fills in on the droplet as reviewers click Approve/Reject in Lark.`)
  process.exit(0)
}

const total = rows.length
const approved = rows.filter(r => approvedStatus(r.status)).length
console.log(`\nReviewed posts (last ${days}d): ${total}  ·  approved ${approved} (${Math.round(100 * approved / total)}%)`)

function rateBy(label: string, key: (r: Row) => string) {
  const m = new Map<string, { a: number; t: number }>()
  for (const r of rows) {
    const k = key(r)
    const e = m.get(k) ?? { a: 0, t: 0 }
    e.t++; if (approvedStatus(r.status)) e.a++
    m.set(k, e)
  }
  console.log(`\n── approval rate by ${label} ──`)
  for (const [k, e] of [...m.entries()].sort((x, y) => y[1].t - x[1].t)) {
    console.log(`  ${k.padEnd(18)} ${String(Math.round(100 * e.a / e.t)).padStart(3)}%  (${e.a}/${e.t})`)
  }
}

rateBy('category', r => r.category || '—')
rateBy('content_mode', r => r.mode || '—')
rateBy('score band', r => {
  const s = r.score ?? 0
  return s >= 9 ? '9–10' : s >= 8 ? '8–9' : s >= 7 ? '7–8' : s >= 6 ? '6–7' : '<6'
})

// By source — credit every source that contributed to an approved/rejected cluster.
const src = new Map<string, { a: number; t: number }>()
for (const r of rows) {
  let ids: string[] = []
  try { ids = JSON.parse(r.itemIds ?? '[]') } catch { /* skip */ }
  if (ids.length === 0) continue
  const names = sqlite
    .prepare(`SELECT DISTINCT source_name FROM news_items WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { source_name: string }[]
  for (const { source_name } of names) {
    const e = src.get(source_name) ?? { a: 0, t: 0 }
    e.t++; if (approvedStatus(r.status)) e.a++
    src.set(source_name, e)
  }
}
console.log(`\n── approval rate by source (min 3 reviews) ──`)
for (const [k, e] of [...src.entries()].filter(([, e]) => e.t >= 3).sort((x, y) => (y[1].a / y[1].t) - (x[1].a / x[1].t))) {
  console.log(`  ${k.padEnd(22)} ${String(Math.round(100 * e.a / e.t)).padStart(3)}%  (${e.a}/${e.t})`)
}
console.log('')
