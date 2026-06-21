/**
 * Category report — how the post mix shifted from the original (severity-scored)
 * bot to the redesigned (Polymarket-category + market-fit) bot. Read-only.
 * Run on the box with the real history:
 *
 *   DB_PATH=/var/lib/signaldesk/signaldesk.db npx tsx scripts/category-report.ts [cutoff=2026-06-19]
 *
 * Items/posts created BEFORE the cutoff = original bot; ON/AFTER = redesigned bot.
 * (Default cutoff is the redesign deploy day.)
 */
import { sqlite } from '../src/lib/db'

const cutoffArg = process.argv[2] ?? '2026-06-19'
const cutoff = new Date(cutoffArg).getTime()
if (!Number.isFinite(cutoff)) { console.error(`bad cutoff date: ${cutoffArg}`); process.exit(1) }

const pct = (n: number, total: number) => total ? `${Math.round(100 * n / total)}%` : '—'

function beforeAfter(title: string, rows: { category: string; before: number; after: number }[]) {
  const tb = rows.reduce((s, r) => s + r.before, 0)
  const ta = rows.reduce((s, r) => s + r.after, 0)
  console.log(`\n── ${title}  (original n=${tb} · redesigned n=${ta}) ──`)
  console.log(`  ${'category'.padEnd(16)}  original      redesigned`)
  for (const r of rows.sort((x, y) => (y.before + y.after) - (x.before + x.after))) {
    if (r.before + r.after === 0) continue
    console.log(`  ${(r.category || '—').padEnd(16)}  ${pct(r.before, tb).padStart(4)} (${String(r.before).padStart(4)})   ${pct(r.after, ta).padStart(4)} (${String(r.after).padStart(4)})`)
  }
}

console.log('── current active sources by category ──')
const srcCfg = sqlite.prepare(`SELECT category, COUNT(*) c FROM news_sources WHERE is_active=1 GROUP BY category ORDER BY c DESC`).all() as { category: string; c: number }[]
const srcTotal = srcCfg.reduce((s, r) => s + r.c, 0)
for (const r of srcCfg) console.log(`  ${r.category.padEnd(16)} ${String(r.c).padStart(3)} (${pct(r.c, srcTotal)})`)

const itemsRows = sqlite.prepare(`
  SELECT category,
    SUM(CASE WHEN ingested_at <  ? THEN 1 ELSE 0 END) AS before,
    SUM(CASE WHEN ingested_at >= ? THEN 1 ELSE 0 END) AS after
  FROM news_items GROUP BY category
`).all(cutoff, cutoff) as { category: string; before: number; after: number }[]
beforeAfter('INGESTED items by category', itemsRows)

const postRows = sqlite.prepare(`
  SELECT ec.category AS category,
    SUM(CASE WHEN gp.created_at <  ? THEN 1 ELSE 0 END) AS before,
    SUM(CASE WHEN gp.created_at >= ? THEN 1 ELSE 0 END) AS after
  FROM generated_posts gp JOIN event_clusters ec ON ec.id = gp.cluster_id
  GROUP BY ec.category
`).all(cutoff, cutoff) as { category: string; before: number; after: number }[]
beforeAfter('GENERATED POSTS by category  ← the headline comparison', postRows)

console.log(`\ncutoff ${cutoffArg}  ·  before = original severity-scored bot, after = redesigned bot`)
console.log('note: the "redesigned" sample is thin until it has run a few days.\n')
