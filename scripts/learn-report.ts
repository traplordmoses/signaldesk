/**
 * Learn report — reads the per-draft decision `signals` (relevance score, target
 * bucket, content category, market-fit, mode) that generator.ts now records, and
 * correlates them with what reviewers approved vs rejected. This is the feedback
 * loop: it shows what the team actually wants so we can tune scoring/selection
 * from real outcomes instead of guessing. Read-only. Run on the droplet (it has
 * both the review history and the signals):
 *
 *   DB_PATH=/var/lib/signaldesk/signaldesk.db npx tsx scripts/learn-report.ts [days=14]
 */
import { sqlite } from '../src/lib/db'
import { TARGET_MIX, BUCKET_LABEL } from '../src/lib/mix'

const days = Number(process.argv[2] ?? 14)
const since = Date.now() - days * 24 * 60 * 60 * 1000

interface Signals {
  score?: number
  bucket?: string
  contentCategory?: string | null
  sourceCategory?: string
  market?: { matched?: boolean; category?: string | null; volume?: number }
  mode?: string
  chars?: number
}
interface Row { status: string; signals: string | null }

const rows = sqlite.prepare(`
  SELECT status, signals FROM generated_posts
  WHERE signals IS NOT NULL AND created_at >= ?
`).all(since) as Row[]

if (rows.length === 0) {
  console.log(`No drafts with decision signals in the last ${days}d.`)
  console.log(`The 'signals' column fills in as new posts are generated after this deploy.`)
  process.exit(0)
}

const parsed = rows.map(r => {
  let s: Signals = {}
  try { s = JSON.parse(r.signals ?? '{}') as Signals } catch { /* leave {} */ }
  return { status: r.status, s }
})
const isApproved = (st: string) => st === 'approved' || st === 'posted'
const isReviewed = (st: string) => isApproved(st) || st === 'rejected'
const reviewed = parsed.filter(p => isReviewed(p.status))

const pct = (n: number) => `${Math.round(n * 100)}%`
const bar = '='.repeat(64)

console.log(`\n${bar}\nLEARN REPORT — last ${days}d\n${bar}`)
console.log(`drafts w/ signals: ${parsed.length}   ·   reviewed: ${reviewed.length}   ·   approved: ${reviewed.filter(p => isApproved(p.status)).length}`)

// ── 1) Output mix (what the bot produced) vs the target spread ──────────────
console.log(`\n— OUTPUT MIX vs TARGET (bucket share of all drafts) —`)
const bucketCounts = new Map<string, number>()
for (const p of parsed) {
  const b = p.s.bucket ?? 'other'
  bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1)
}
const totalDrafts = parsed.length
const allBuckets = Array.from(new Set([...Object.keys(TARGET_MIX), ...bucketCounts.keys()]))
for (const b of allBuckets.sort((a, c) => (bucketCounts.get(c) ?? 0) - (bucketCounts.get(a) ?? 0))) {
  const actual = (bucketCounts.get(b) ?? 0) / totalDrafts
  const target = TARGET_MIX[b] ?? 0
  const delta = actual - target
  const flag = Math.abs(delta) < 0.03 ? '  ok ' : delta > 0 ? ' OVER' : 'UNDER'
  console.log(`  ${(BUCKET_LABEL[b] ?? b).padEnd(22)} actual ${pct(actual).padStart(4)}  target ${pct(target).padStart(4)}  ${flag}`)
}

// ── 2) Approval rate by dimension (fills in as reviewers click in Lark) ──────
if (reviewed.length === 0) {
  console.log(`\n(no approve/reject decisions yet — approval-rate breakdowns fill in as reviewers act in Lark)`)
} else {
  const rateBy = (label: string, key: (s: Signals) => string) => {
    console.log(`\n— APPROVAL RATE BY ${label} —`)
    const m = new Map<string, { a: number; t: number }>()
    for (const p of reviewed) {
      const k = key(p.s) || '(none)'
      const e = m.get(k) ?? { a: 0, t: 0 }
      e.t++; if (isApproved(p.status)) e.a++
      m.set(k, e)
    }
    for (const [k, e] of [...m.entries()].sort((x, y) => y[1].t - x[1].t)) {
      console.log(`  ${k.padEnd(22)} ${pct(e.a / e.t).padStart(4)}  (${e.a}/${e.t})`)
    }
  }
  rateBy('BUCKET', s => s.bucket ?? 'other')
  rateBy('CONTENT CATEGORY', s => s.contentCategory ?? 'none')
  rateBy('MODE', s => s.mode ?? '?')
  rateBy('MARKET MATCH', s => (s.market?.matched ? 'live-market' : 'no-market'))

  console.log(`\n— APPROVAL RATE BY SCORE BAND —`)
  const band = (n: number) => n >= 9 ? '9-10' : n >= 8 ? '8-9' : n >= 7 ? '7-8' : n >= 6 ? '6-7' : '<6'
  const bm = new Map<string, { a: number; t: number }>()
  for (const p of reviewed) {
    const k = band(p.s.score ?? 0)
    const e = bm.get(k) ?? { a: 0, t: 0 }
    e.t++; if (isApproved(p.status)) e.a++
    bm.set(k, e)
  }
  for (const k of ['9-10', '8-9', '7-8', '6-7', '<6']) {
    const e = bm.get(k)
    if (e) console.log(`  ${k.padEnd(22)} ${pct(e.a / e.t).padStart(4)}  (${e.a}/${e.t})`)
  }
}

console.log(`\nRead it as: buckets/categories that approve HIGH but read UNDER deserve more weight;`)
console.log(`those that approve LOW but read OVER are candidates to trim. Score bands that approve`)
console.log(`poorly suggest the threshold should rise; market-matched vs not shows if the spine is earning its boost.\n`)
