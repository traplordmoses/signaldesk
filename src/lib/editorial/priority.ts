import type { Evidence } from './evidence'

export type Lane = 'urgent' | 'routine'
const MATERIAL = /\b(confirms?|confirmed|announces?|announced|approves?|approved|rejects?|rejected|resigns?|resigned|sacks?|sacked|suspends?|suspended|ruled out|line-?ups?|injur(?:y|ed)|withdraws?|withdrawn|ceasefire|rate (?:cut|hike)|inflation|cpi|final result|wins?|won|launches?|launched)\b/i
const PREVIEW = /\b(preview|predictions?|how to watch|betting tips|odds today|fantasy|could|may|opinion|column)\b|\|\s*[A-Z][a-z]+\s+[A-Z]/
export function laneFor(e: Evidence | null, matched: boolean, risk: string | null, now = Date.now()): Lane {
  if (!e || !e.timestampKnown || risk === 'high') return 'routine'
  const age = now - e.publishedAt
  if (age < -60_000 || age > 15 * 60_000 || PREVIEW.test(e.headline)) return 'routine'
  return (e.primary || (matched && e.trusted === true)) && MATERIAL.test(e.headline) ? 'urgent' : 'routine'
}
export function routineDue(lastCreatedAt: number | null, cooldownMinutes: number, now = Date.now()) {
  return !lastCreatedAt || now - lastCreatedAt >= cooldownMinutes * 60_000
}
export function decayedScore(score: number, publishedAt: number, now = Date.now()) {
  return score - Math.max(0, (now - publishedAt) / 3_600_000) * 1.5
}
