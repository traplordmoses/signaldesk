/**
 * Coverage heat and magnitude: the two signals that let a defining story beat
 * the filler that saturated relevance can't tell it apart from. Built after the
 * Man City guilty verdict (2026-09-25) never reached review — replayed on that
 * afternoon's real queue, the old ranking never drafted it; with these it takes
 * the first slot, 14 minutes after arriving.
 */
import { describe, it, expect } from 'vitest'
import { outletKey, buildHeatIndex, heatBonus, HEAT_MAX_BONUS } from './heat'
import { magnitudeBonus, MAGNITUDE_BYPASS } from '@/lib/ai/novelty'
import { sameStory, buildDocFrequency, distinctivenessCutoff } from '@/lib/news/clusterer'

describe('outletKey', () => {
  it('collapses one organisation\'s feeds to one outlet', () => {
    expect(outletKey('https://www.bbc.co.uk/sport/football/123', 'bbc_sport'))
      .toBe(outletKey('https://www.bbc.co.uk/sport/football/456', 'bbc_football'))
    expect(outletKey('https://www.bbc.co.uk/x', 'bbc_sport')).toBe('bbc.co.uk')
    expect(outletKey('https://www.nytimes.com/athletic/1', 'the_athletic')).toBe('nytimes.com')
  })

  it('counts an aggregator once per feed, since its URLs hide the publisher', () => {
    expect(outletKey('https://news.google.com/rss/articles/abc', 'gn_ufc')).toBe('feed:gn_ufc')
    expect(outletKey('https://news.google.com/rss/articles/xyz', 'gn_mls')).toBe('feed:gn_mls')
  })

  it('survives a malformed URL', () => {
    expect(outletKey('not a url', 'some_feed')).toBe('feed:some_feed')
  })
})

describe('HeatIndex.coverage', () => {
  // Filler so the story's own words are rare (distinctive) in the window.
  const filler = Array.from({ length: 120 }, (_, i) => ({
    title: `Unrelated market item ${i} about shipping and freight rates`, url: `https://filler${i % 7}.example/a${i}`, sourceId: 'filler', clusterId: null,
  }))
  const verdict = [
    { title: 'Manchester City found guilty on almost all Premier League charges relating to financial breaches', url: 'https://www.nytimes.com/athletic/1', sourceId: 'the_athletic', clusterId: 'c1' },
    { title: 'Man City found guilty on almost all 115 Premier League charges: Report', url: 'https://www.aljazeera.com/sports/1', sourceId: 'aljazeera', clusterId: 'c2' },
    { title: 'Manchester City found guilty of breaching Premier League financial regulations', url: 'https://www.cbssports.com/soccer/1', sourceId: 'cbs_sports', clusterId: 'c3' },
    { title: 'Man City found guilty of breaking financial rules', url: 'https://www.bbc.co.uk/sport/1', sourceId: 'bbc_sport', clusterId: 'c4' },
    { title: 'Man City found guilty of breaking Premier League rules', url: 'https://www.bbc.co.uk/sport/2', sourceId: 'bbc_football', clusterId: 'c5' },
  ]
  const window = [...filler, ...verdict]
  const index = buildHeatIndex(window, window.map(w => w.title))

  it('counts distinct outlets across clusters the clusterer split apart', () => {
    const cov = index.coverage(verdict[0].title, 'c1')
    // Athletic, Al Jazeera, CBS, BBC — and BBC's two feeds count once.
    expect(cov.outlets).toBe(4)
    expect(cov.keys).toContain('bbc.co.uk')
  })

  it('gives a one-outlet story no heat', () => {
    expect(index.coverage('Unrelated market item 3 about shipping and freight rates', null).outlets).toBeLessThanOrEqual(2)
  })

  it('knows the drafted verdict and a new copy of it are the same story', () => {
    expect(index.sameStoryAs(verdict[0].title, verdict[1].title)).toBe(true)
  })
})

describe('bonuses', () => {
  it('heat: nothing for one or two outlets, capped for mega-stories', () => {
    expect(heatBonus(1)).toBe(0)
    expect(heatBonus(2)).toBe(0)
    expect(heatBonus(6)).toBe(3)
    expect(heatBonus(40)).toBe(HEAT_MAX_BONUS)
  })

  it('magnitude: nothing up to 4, a 9 outweighs saturated relevance', () => {
    expect(magnitudeBonus(undefined)).toBe(0)
    expect(magnitudeBonus(4)).toBe(0)
    expect(magnitudeBonus(9)).toBeCloseTo(6)
    expect(magnitudeBonus(9)).toBeGreaterThan(1.5 + 1.7)  // > the gap to 10.0 filler plus a mix bonus
    expect(MAGNITUDE_BYPASS).toBe(7)
  })
})

describe('entity guard: name variants of ONE entity no longer split a story', () => {
  const corpus = [
    ...Array.from({ length: 120 }, (_, i) => `Unrelated market item ${i} about shipping and freight rates`),
    'Manchester City found guilty on almost all Premier League charges',
    'Man City found guilty on almost all 115 Premier League charges: Report',
    'Man City inquiry moves to appeal stage amid reports majority of PL charges proven',
    'Manchester City found guilty of breaking Premier League’s financial rules',
  ]
  const df = buildDocFrequency(corpus)
  const dfMax = distinctivenessCutoff(corpus.length)
  const same = (a: string, b: string) => sameStory(a, b, df, dfMax)

  it('Man City = Manchester City (clipped form)', () => {
    expect(same('Manchester City found guilty on almost all Premier League charges', 'Man City found guilty on almost all 115 Premier League charges: Report')).toBe(true)
  })

  it('a possessive is not a new entity', () => {
    expect(same('Manchester City found guilty on almost all Premier League charges', 'Manchester City found guilty of breaking Premier League’s financial rules')).toBe(true)
  })

  it('still separates different clubs, countries and companies', () => {
    const t = [
      ['Man City beat Chelsea to go top of the Premier League', 'Man United beat Chelsea to go top of the Premier League'],
      ['US imposes new tariffs on Chinese steel imports', 'UK imposes new tariffs on Chinese steel imports'],
      ['Anthropic blocks accounts of several scientists in Boston', 'OpenAI blocks accounts of several scientists in Boston'],
    ]
    const tdf = buildDocFrequency(t.flat())
    for (const [a, b] of t) expect(sameStory(a, b, tdf, distinctivenessCutoff(t.flat().length))).toBe(false)
  })
})
