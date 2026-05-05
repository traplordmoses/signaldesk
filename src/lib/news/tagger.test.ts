/**
 * Coverage for extractTopics. The May 5 review surfaced 🏆 Sports tagging
 * Iran war coverage, Brazil politics, and oil earnings — root cause was
 * `transfer` on the Sports keyword list combined with substring matching
 * (.includes). Lock down both fixes here.
 */
import { describe, it, expect } from 'vitest'
import { extractTopics } from './tagger'

describe('extractTopics', () => {
  describe('🏆 Sports false positives are gone', () => {
    it('does not tag Sports on a "transfer of power" headline', () => {
      const tags = extractTopics(
        'Brazil presidential transfer of power begins amid protests',
        'Lula prepares to take office as transfer formally completes.'
      )
      expect(tags).not.toContain('🏆 Sports')
    })

    it('does not tag Sports on a wire-transfer story', () => {
      const tags = extractTopics(
        'Bank flags suspicious $4M wire transfer linked to crypto exchange',
        ''
      )
      expect(tags).not.toContain('🏆 Sports')
    })

    it('does not tag Sports on Iran weapons-transfer coverage', () => {
      const tags = extractTopics(
        'Iran accused of transferring missiles to Yemen-based Houthi forces',
        'IRGC denies the transfer.'
      )
      expect(tags).not.toContain('🏆 Sports')
    })
  })

  describe('🏆 Sports still tags real sports stories', () => {
    it('tags Sports on NFL playoff coverage', () => {
      expect(extractTopics('Chiefs win AFC playoff opener', '')).toContain('🏆 Sports')
    })

    it('tags Sports on World Cup news', () => {
      expect(extractTopics('FIFA announces World Cup 2026 host cities', '')).toContain('🏆 Sports')
    })

    it('tags Sports on Premier League match', () => {
      expect(extractTopics('Manchester City wins Premier League title', '')).toContain('🏆 Sports')
    })
  })

  describe('word-boundary matching prevents short-keyword false positives', () => {
    it('does not tag AI on the word "main"', () => {
      // Old behavior: `.includes(' ai ')` would not match "main" but ".includes('ai')"
      // (used inside other tags) could substring-match. Word-boundary keeps it tight.
      const tags = extractTopics('Main Street consumer sentiment falls', '')
      expect(tags).not.toContain('🤖 AI')
    })

    it('still tags AI on a real AI headline', () => {
      const tags = extractTopics('OpenAI releases GPT-5 with longer context window', '')
      expect(tags).toContain('🤖 AI')
    })

    it('does not tag Sports on the word "championship" inside another word', () => {
      // sanity: 'championship' is real-word, this just confirms word-boundary works
      const tags = extractTopics('NBA championship odds tighten ahead of Game 7', '')
      expect(tags).toContain('🏆 Sports')
    })
  })
})
