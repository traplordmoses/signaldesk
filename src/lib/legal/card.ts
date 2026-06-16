/**
 * Pure rendering of the Legal Redline verdict for a Lark review card. Kept
 * dependency-free (no DB, no Lark client) so it's unit-testable in isolation;
 * messages.ts feeds it a post's legal_* fields. See LEGAL_REDLINE_INTEGRATION.md.
 */

export interface LegalCardFields {
  verdict?: string | null
  risk?: string | null
  rationale?: string | null
  redline?: string | null
}

function legalBadge(verdict: string): string {
  switch (verdict) {
    case 'pass':  return '✅ Pass'
    case 'flag':  return '⚠️ Flag'
    case 'block': return '⛔ Block'
    case 'error': return '❓ Review unavailable'
    default:      return verdict
  }
}

/**
 * Markdown for the "⚖️ Legal" block, or null when there's no review yet
 * (feature off / not reviewed) so the card stays unchanged in that case.
 */
export function renderLegalBlock(r: LegalCardFields): string | null {
  if (!r.verdict) return null
  let head = `⚖️ **Legal:** ${legalBadge(r.verdict)}`
  if (r.risk && r.risk !== 'unknown') head += `  ·  risk **${r.risk}**`
  const lines = [head]
  if (r.rationale) lines.push(`_${r.rationale}_`)
  if (r.redline) lines.push(`**Suggested:** ${r.redline}`)
  return lines.join('\n')
}
