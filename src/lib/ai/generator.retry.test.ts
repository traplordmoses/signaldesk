/**
 * Corrective retry on a fact-check rejection.
 *
 * Reproduces the failure mode behind the Man City clusters rejected on 2026-09-26/29:
 * the source never says 115, the drafting model added "115 charges" from memory, the
 * checker rightly rejected it ("unsupported numeric detail: 115"), and the old retry
 * re-ran the SAME prompt three times and got the same mistake. Now the rejection
 * reason goes back to the model once.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db, sqlite } from '@/lib/db'
import { migrateNewsroom } from '@/lib/db/newsroom'
import { generatePost } from './generator'

const HEADLINE = 'Premier League confirm Man City guilty of all charges - 5 Live reaction'
const draft = (content: string) => JSON.stringify({
  content_mode: 'pure_news', has_market: false, include_link: false,
  content, char_count: content.length, estimated_score: 8, score_explanation: 'big story',
})
const reply = (text: string) => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })

function seed(id: string) {
  const now = Date.now()
  sqlite.prepare(`INSERT OR REPLACE INTO news_sources (id, name, url, category, weight, is_active) VALUES ('bbc_sport','BBC Sport','https://bbc.example/rss','sports',8,1)`).run()
  sqlite.prepare(`INSERT INTO news_items (id, title, summary, url, url_hash, title_hash, source_id, source_name, category, published_at, ingested_at, cluster_id, is_processed, timestamp_confidence)
    VALUES (?, ?, ?, ?, ?, ?, 'bbc_sport', 'BBC Sport', 'sports', ?, ?, ?, 1, 'feed')`)
    .run(`item-${id}`, HEADLINE, HEADLINE, `https://bbc.example/${id}`, `u-${id}`, `t-${id}`, now - 10 * 60_000, now - 9 * 60_000, id)
  sqlite.prepare(`INSERT INTO event_clusters (id, canonical_headline, category, relevance_score, risk_level, status, first_seen_at, last_updated_at, post_count, source_count, constituent_item_ids, constituent_summaries)
    VALUES (?, ?, 'sports', 10, 'low', 'new', ?, ?, 0, 1, ?, ?)`).run(id, HEADLINE, now - 9 * 60_000, now - 9 * 60_000, JSON.stringify([`item-${id}`]), JSON.stringify([HEADLINE]))
  return db.query.eventClusters.findFirst({ where: (c, { eq }) => eq(c.id, id) })
}

describe('generatePost corrective retry', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: './drizzle' })
    migrateNewsroom(sqlite)
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })
  afterEach(() => vi.restoreAllMocks())

  it('re-drafts once with the rejection reason and keeps the corrected draft', async () => {
    const cluster = await seed('mc-retry')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      // 1st draft adds the number from memory -> deterministic check rejects it, no verifier call
      .mockResolvedValueOnce(reply(draft('🟣 JUST IN: The Premier League confirmed Man City guilty of all 115 charges.')))
      // corrective re-draft
      .mockResolvedValueOnce(reply(draft('🟣 JUST IN: The Premier League confirmed Man City are guilty of all charges.')))
      // verifier on the corrected draft
      .mockResolvedValueOnce(reply(JSON.stringify({ supported: true, evidence: ['Premier League confirm Man City guilty of all charges'], reason: 'ok' })))

    const post = await generatePost(cluster!)
    expect(post.content).toContain('guilty of all charges')
    expect(post.content).not.toContain('115')

    const retryPrompt = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[0].content as string
    expect(retryPrompt).toContain('YOUR PREVIOUS DRAFT WAS REJECTED')
    expect(retryPrompt).toContain('unsupported numeric detail: 115')
  })

  it('still drops the story if the corrected draft is rejected too', async () => {
    const cluster = await seed('mc-twice')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(draft('🟣 JUST IN: The Premier League confirmed Man City guilty of all 115 charges.')))
      .mockResolvedValueOnce(reply(draft('🟣 JUST IN: The Premier League confirmed Man City guilty on 115 counts.')))
    await expect(generatePost(cluster!)).rejects.toThrow()
  })

  it('does not retry failures that are not fact-check rejections', async () => {
    const cluster = await seed('mc-http')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad request', { status: 400 }))
    await expect(generatePost(cluster!)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
