/**
 * The team's target post-category spread (the "Recommended %" table) and the
 * mapping from scorer/source categories into those buckets. Single source of
 * truth shared by the scheduler (selection steering) and category-report.
 *
 * The eight buckets mirror the table exactly — note politics & elections and
 * breaking/geopolitics are kept SEPARATE.
 */
// Rebalanced 2026-09-10 against ten days of review decisions (the first ten
// days the team was actually clicking). Approval rate by content category:
//
//   crypto 44%  ·  tech_ai 22%  ·  sports 21%  ·  economy 16%
//   elections 13%  ·  geopolitics 10%  ·  pop_culture 4%
//
// crypto and AI were the two best-performing categories AND the two most
// starved; culture was the worst performer and took the second-most slots.
// tech_ai also gets its own bucket here — it used to roll up into
// science_health and compete with health, space and cyber for a single 10%
// slice, which is the structural reason AI news was rare.
export const TARGET_MIX: Record<string, number> = {
  politics_elections:   0.15,
  breaking_geopolitics: 0.08,
  sports:               0.18,
  economics:            0.12,
  crypto:               0.12,
  tech_ai:              0.15,
  culture:              0.05,
  science_health:       0.10,
  local:                0.05,
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
