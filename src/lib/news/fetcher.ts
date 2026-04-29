import Parser from 'rss-parser'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { newsSources, newsItems, auditLog } from '@/lib/db/schema'
import { eq, gt, and } from 'drizzle-orm'
import { scoreItem, detectRisk } from './scorer'

const parser = new Parser({ timeout: 10000 })

function sha256(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

// Normalize URL for dedup: lowercase host, drop UTM/tracking params, strip trailing slash,
// strip fragment, strip AMP suffix. Same article via Reuters direct + AMP + Google News
// redirect now hashes to the same value.
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref|ref_|igshid|s_cid|share)/i
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    u.host = u.host.toLowerCase()
    const keep = new URLSearchParams()
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.append(k, v)
    }
    u.search = keep.toString() ? `?${keep.toString()}` : ''
    let path = u.pathname.replace(/\/+$/, '')                  // trailing slash
    path = path.replace(/\/(amp|amp\.html|amp\.htm)$/i, '')    // AMP suffix
    u.pathname = path || '/'
    return u.toString()
  } catch {
    return raw
  }
}

// Title-hash key: lowercase, strip newsy prefixes (BREAKING:, JUST IN:, EXCLUSIVE:),
// strip non-alphanumerics, take first 12 tokens. "BREAKING: Fed Holds Rates Steady"
// and "Fed Holds Rates Steady After Powell Remarks" now collide; ditto reordered/punctuation variants.
const TITLE_PREFIXES = /^(breaking|just in|exclusive|update|live|developing|alert|watch)\s*:/i
function titleWords(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(TITLE_PREFIXES, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.split(' ').slice(0, 12).join(' ')
}

interface NormalizedItem {
  id: string
  title: string
  summary: string
  url: string
  urlHash: string
  titleHash: string
  sourceId: string
  sourceName: string
  category: string
  publishedAt: number
}

async function fetchSource(source: typeof newsSources.$inferSelect): Promise<{ items: NormalizedItem[]; error?: string }> {
  try {
    const feed = await parser.parseURL(source.url)
    const items: NormalizedItem[] = []

    for (const entry of feed.items ?? []) {
      const url = entry.link ?? entry.guid ?? ''
      if (!url) continue

      const title = entry.title ?? ''
      const summary = entry.contentSnippet ?? entry.summary ?? entry.content ?? ''
      const publishedAt = entry.pubDate ? new Date(entry.pubDate).getTime() : Date.now()

      const normalizedUrl = normalizeUrl(url)
      items.push({
        id: crypto.randomUUID(),
        title,
        summary: summary.slice(0, 500),
        url: normalizedUrl,
        urlHash: sha256(normalizedUrl),
        titleHash: sha256(titleWords(title)),
        sourceId: source.id,
        sourceName: source.name,
        category: source.category,
        publishedAt,
      })
    }

    return { items }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { items: [], error }
  }
}

export async function fetchAllSources(): Promise<{ ingested: number; errors: number }> {
  const sources = db.select().from(newsSources).where(eq(newsSources.isActive, 1)).all()

  let ingested = 0
  let errors = 0

  const results = await Promise.allSettled(sources.map(s => fetchSource(s)))

  for (let i = 0; i < results.length; i++) {
    const source = sources[i]
    const result = results[i]

    if (result.status === 'rejected' || result.value.error) {
      errors++
      const errMsg = result.status === 'rejected' ? String(result.reason) : result.value.error!
      // Update source error
      db.update(newsSources)
        .set({ lastError: errMsg, lastFetchedAt: Date.now() })
        .where(eq(newsSources.id, source.id))
        .run()

      try {
        db.insert(auditLog).values({
          id: crypto.randomUUID(),
          eventType: 'error',
          entityType: 'news_source',
          entityId: source.id,
          errorCode: 'FETCH_FAILED',
          errorMessage: errMsg,
          details: JSON.stringify({ sourceUrl: source.url }),
          createdAt: Date.now(),
        }).run()
      } catch (e) {
        console.error(`audit log write failed (news_source ${source.id}):`, e)
      }
      continue
    }

    const { items } = result.value
    const weight = source.weight ?? 5
    // Dedup window for title-hash bumped from 4h → 24h. RSS feeds often re-publish
    // the same article hours later with a slightly mutated URL (rotating tracking
    // params, AMP variants my normalizer doesn't catch, etc.). 4h was too narrow
    // — the same Trump-approval story re-clustered every 4-5h and produced a fresh
    // event_cluster, which the cron then re-sent to Lark.
    const titleDedupCutoff = Date.now() - 24 * 60 * 60 * 1000

    for (const item of items) {
      try {
        // Check url_hash dedup
        const existing = db.select({ id: newsItems.id })
          .from(newsItems)
          .where(eq(newsItems.urlHash, item.urlHash))
          .get()
        if (existing) continue

        // Check title_hash near-dedup (last 24 hours)
        const recentTitle = db.select({ id: newsItems.id })
          .from(newsItems)
          .where(
            and(
              eq(newsItems.titleHash, item.titleHash),
              gt(newsItems.ingestedAt, titleDedupCutoff)
            )
          )
          .get()
        if (recentTitle) continue

        const score = scoreItem(item.title, item.summary ?? '', weight, item.publishedAt)
        const risk = detectRisk(item.title + ' ' + (item.summary ?? ''))

        db.insert(newsItems).values({
          ...item,
          ingestedAt: Date.now(),
          relevanceScore: score,
          riskLevel: risk.level,
          riskReasons: JSON.stringify(risk.reasons),
          isProcessed: 0,
        }).run()

        ingested++
      } catch (e) {
        console.error(`news_item insert failed (url=${item.url.slice(0, 80)}):`, e)
      }
    }

    // Update last fetched
    db.update(newsSources)
      .set({ lastFetchedAt: Date.now(), lastError: null })
      .where(eq(newsSources.id, source.id))
      .run()
  }

  try {
    db.insert(auditLog).values({
      id: crypto.randomUUID(),
      eventType: 'news_ingested',
      details: JSON.stringify({ ingested, errors }),
      createdAt: Date.now(),
    }).run()
  } catch (e) {
    console.error('audit log write failed (news_ingested):', e)
  }

  return { ingested, errors }
}
