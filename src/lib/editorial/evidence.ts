import { sqlite } from '@/lib/db'

export interface Evidence {
  headline: string; text: string; publishedAt: number; ingestedAt: number
  source: string; url: string; timestampKnown: boolean; primary: boolean; trusted?: boolean
}
/** Canonical article only: do not let unrelated cluster members supply invented facts. */
export function evidenceFor(cluster: { id: string; canonicalHeadline: string }): Evidence | null {
  const row = sqlite.prepare(`SELECT n.*, s.weight FROM news_items n LEFT JOIN news_sources s ON s.id=n.source_id
    WHERE n.cluster_id=? ORDER BY (n.title=?) DESC,n.published_at DESC LIMIT 1`).get(cluster.id, cluster.canonicalHeadline) as {
      title: string; summary: string | null; published_at: number; ingested_at: number
      weight: number; source_name: string; source_id: string; url: string; timestamp_confidence?: string
    } | undefined
  if (!row) return null
  return {
    headline: row.title, text: `${row.title}\n${row.summary ?? ''}`, publishedAt: row.published_at,
    ingestedAt: row.ingested_at, source: row.source_name, url: row.url,
    timestampKnown: row.timestamp_confidence === 'feed',
    trusted: (row.weight ?? 0) >= 8,
    primary: /^(fed_|whitehouse_|sec_|nws_|usgs_|openai_blog|deepmind_blog|primary_x_)/.test(row.source_id),
  }
}

export function freshnessLabel(e: Pick<Evidence, 'publishedAt' | 'timestampKnown'>, urgent: boolean, now = Date.now()) {
  const age = now - e.publishedAt
  if (!e.timestampKnown || age < -60_000) return 'UPDATE'
  if (urgent && age <= 15 * 60_000) return 'BREAKING'
  return age <= 60 * 60_000 ? 'JUST IN' : 'UPDATE'
}

/** Fast deterministic support gate. A second semantic verifier handles claim meaning. */
export function checkFactualSupport(content: string, evidence: string): void {
  const numbers = new Set(evidence.replace(/,/g, '').match(/\b\d+(?:\.\d+)?\b/g) ?? [])
  for (const n of content.replace(/,/g, '').match(/\b\d+(?:\.\d+)?\b/g) ?? []) {
    if (!numbers.has(n)) throw new Error(`unsupported numeric detail: ${n}`)
  }
  for (const qualifier of ['allegedly', 'reportedly']) {
    if (new RegExp(`\\b${qualifier}\\b`, 'i').test(evidence) && !/allegedly|reportedly|according to|says|said|accused|reports|sources/i.test(content)) {
      throw new Error('source uncertainty must be preserved')
    }
  }
  if (/\b(first[- ]ever|largest ever|record[- ]breaking)\b/i.test(content) && !/\b(first|largest|record)\b/i.test(evidence)) {
    throw new Error('unsupported superlative')
  }
}

export function applyFreshness(content: string, e: Evidence, urgent: boolean): string {
  return content.replace(/\b(?:BREAKING|JUST IN|NEW|UPDATE):/i, `${freshnessLabel(e, urgent)}:`)
}
