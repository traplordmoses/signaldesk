/**
 * Catchiness scoring. The model call is mocked; what is pinned here is the part
 * that decides outcomes — how a rating becomes relevance points, that it lifts
 * rather than replaces, that it never pushes past 10, and that a failure can't
 * break clustering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { noveltyBoost, applyNovelty, noveltyFor } from './novelty'
import { sqlite } from '@/lib/db'

describe('noveltyBoost', () => {
  it('adds nothing up to a 5', () => {
    for (const n of [0, 1, 3, 5]) expect(noveltyBoost(n)).toBe(0)
  })

  it('lifts a 9 by exactly what a category-less story needs to reach the gate', () => {
    // The DoorDash story sits at ~1.5 with no category or market; 1.5 + 5 = 6.5.
    expect(noveltyBoost(9)).toBe(5)
  })

  it('is monotonic and bounded', () => {
    expect(noveltyBoost(10)).toBe(6.25)
    expect(noveltyBoost(15)).toBe(6.25)
    expect(noveltyBoost(NaN)).toBe(0)
  })
})

describe('applyNovelty', () => {
  const reply = (scores: { id: number; score: number }[]) =>
    new Response(JSON.stringify({ content: [{ text: JSON.stringify({ scores }) }] }), { status: 200 })

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    sqlite.exec('CREATE TABLE IF NOT EXISTS event_clusters (id TEXT PRIMARY KEY, relevance_score REAL)')
    sqlite.exec('DELETE FROM event_clusters')
    sqlite.exec('DROP TABLE IF EXISTS cluster_novelty')
    const ins = sqlite.prepare('INSERT INTO event_clusters (id, relevance_score) VALUES (?, ?)')
    ins.run('weird', 1.5)
    ins.run('filler', 9.7)
    ins.run('strong', 8.0)
  })
  afterEach(() => vi.restoreAllMocks())

  const clusters = [
    { id: 'weird', headline: 'Accused plotter moderated r/DoorDash', baseScore: 1.5 },
    { id: 'filler', headline: 'How to watch Rams vs 49ers', baseScore: 9.7 },
    { id: 'strong', headline: 'Military admits weapons in orbit for the first time', baseScore: 8.0 },
  ]
  const relevance = (id: string) =>
    (sqlite.prepare('SELECT relevance_score AS r FROM event_clusters WHERE id = ?').get(id) as { r: number }).r

  it('lifts unusual stories and leaves routine ones alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([
      { id: 0, score: 10 }, { id: 1, score: 0 }, { id: 2, score: 9 },
    ]))
    const r = await applyNovelty(clusters)
    expect(r).toMatchObject({ rated: 3, lifted: 2 })
    expect(relevance('weird')).toBe(7.75)   // 1.5 + 6.25: over the 6.5 gate
    expect(relevance('filler')).toBe(9.7)   // lift only, never a penalty
  })

  it('never pushes relevance past 10', async () => {
    // Ids sent to the model are positions WITHIN the batch, so a one-cluster call
    // is id 0 whatever the cluster's place in the wider list.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([{ id: 0, score: 10 }]))
    await applyNovelty([clusters[2]])
    expect(relevance('strong')).toBe(10)
  })

  it('records the rating for the selection-time preference', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([{ id: 0, score: 9 }]))
    await applyNovelty([clusters[0]])
    expect(noveltyFor(['weird', 'filler']).get('weird')).toBe(9)
    expect(noveltyFor(['weird', 'filler']).has('filler')).toBe(false)
  })

  it('ignores ratings outside 0-10 rather than trusting them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([{ id: 0, score: 42 }]))
    const r = await applyNovelty([clusters[0]])
    expect(r.rated).toBe(0)
    expect(relevance('weird')).toBe(1.5)
  })

  it('never throws — a model outage means no lift, not a failed clustering run', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('overloaded', { status: 529 }))
    const r = await applyNovelty(clusters)
    expect(r.rated).toBe(0)
    expect(r.errors.length).toBe(1)
    expect(relevance('weird')).toBe(1.5)
  })
})
