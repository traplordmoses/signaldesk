/**
 * The team's target post-category spread (the "Recommended %" table) and the
 * mapping from scorer/source categories into those buckets. Single source of
 * truth shared by the scheduler (selection steering) and category-report.
 *
 * The eight buckets mirror the table exactly — note politics & elections and
 * breaking/geopolitics are kept SEPARATE.
 */
export const TARGET_MIX: Record<string, number> = {
  politics_elections:   0.18,
  breaking_geopolitics: 0.12,
  sports:               0.20,
  economics:            0.13,
  crypto:               0.05,
  culture:              0.12,
  science_health:       0.10,
  local:                0.10,
}

export const BUCKET_LABEL: Record<string, string> = {
  politics_elections:   'Politics & elections',
  breaking_geopolitics: 'Breaking / geopolitics',
  sports:               'Sports',
  economics:            'Economics / finance',
  crypto:               'Crypto',
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
  tech_ai: 'science_health', health_science: 'science_health', space: 'science_health', cyber: 'science_health',
  weather: 'local',
  // source-category fallbacks
  economics: 'economics', tech: 'science_health', science: 'science_health',
  health: 'science_health', entertainment: 'culture', music: 'culture',
}

/**
 * Bucket a story by its CONTENT category (preferred) with the source category as
 * fallback. Returns 'other' if neither maps.
 */
export function bucketForCategory(contentCategory: string | null, sourceCategory: string): string {
  return BUCKET_OF[contentCategory ?? ''] ?? BUCKET_OF[sourceCategory] ?? 'other'
}
