/**
 * The team's target post-category spread (the "Recommended %" table) and the
 * mapping from scorer/source categories into those buckets. Single source of
 * truth shared by the scheduler (selection steering) and category-report.
 *
 * The eight buckets mirror the table exactly — note politics & elections and
 * breaking/geopolitics are kept SEPARATE.
 */
// Rebalanced 2026-09-18, the second pass on real review decisions. Approval
// rate by content category, Sep 11-17 (drafts in brackets):
//
//   space 38% (8)  ·  sports 11% (99)  ·  crypto 9% (34)  ·  economy 8% (60)
//   geopolitics 8% (25)  ·  tech_ai 7% (104)  ·  elections 5% (20)
//   politics 4% (26)  ·  pop_culture 0% (43)
//
// Sports up 18 -> 28%: the team asked for it explicitly, it is the best-approving
// category at real volume, and ~90% of Probly's ~1,900 live markets are sports,
// so these are the stories that can carry a market link. tech_ai down 15 -> 12%:
// it was drafting 24% of posts at 7% approval (the steering-strength fix in the
// scheduler is what actually holds it here). science_health up to 13% because
// space lives in it. culture down to 3%: zero approvals from 43 drafts.
export const TARGET_MIX: Record<string, number> = {
  sports:               0.28,
  science_health:       0.13,
  tech_ai:              0.12,
  crypto:               0.12,
  politics_elections:   0.12,
  economics:            0.10,
  breaking_geopolitics: 0.08,
  culture:              0.03,
  local:                0.02,
}

export const BUCKET_LABEL: Record<string, string> = {
  politics_elections:   'Politics & elections',
  breaking_geopolitics: 'Breaking / geopolitics',
  sports:               'Sports',
  economics:            'Economics / finance',
  crypto:               'Crypto',
  tech_ai:              'Tech & AI',
  culture:              'Culture / entertainment',
  science_health:       'Science / health',
  local:                'Local / hyperlocal',
  other:                'Other / uncategorized',
}

// Roll scorer (content) categories AND source categories up into a target bucket.
// Content-category wins (a Reuters story about a film buckets as culture, not
// politics); source category is the fallback. Domestic politics/elections is kept
// distinct from breaking/geopolitics.
const BUCKET_OF: Record<string, string> = {
  // scorer content-categories
  politics: 'politics_elections', elections: 'politics_elections',
  geopolitics: 'breaking_geopolitics',
  sports: 'sports', economy_finance: 'economics',
  crypto: 'crypto',
  pop_culture: 'culture', mentions: 'culture', gaming: 'culture',
  tech_ai: 'tech_ai',
  health_science: 'science_health', space: 'science_health', cyber: 'science_health',
  weather: 'local',
  // source-category fallbacks
  economics: 'economics', tech: 'tech_ai', science: 'science_health',
  health: 'science_health', entertainment: 'culture', music: 'culture',
}

/**
 * Bucket a story by its CONTENT category (preferred) with the source category as
 * fallback. Returns 'other' if neither maps.
 */
export function bucketForCategory(contentCategory: string | null, sourceCategory: string): string {
  return BUCKET_OF[contentCategory ?? ''] ?? BUCKET_OF[sourceCategory] ?? 'other'
}
