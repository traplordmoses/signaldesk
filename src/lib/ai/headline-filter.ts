/**
 * Pre-LLM headline filter — drops low-signal cluster headlines before they
 * reach the LLM. Saves Anthropic spend on opinion pieces, recap formats,
 * podcasts, and other content shapes that aren't breaking news.
 *
 * Originally inspired by the `is_breaking_worthy()` filter in the prototype
 * (/Users/bengalagan/prediction-bot). Keep this list conservative — false
 * negatives just mean an extra LLM call, but false positives silently drop
 * real news. Only add patterns that almost never appear in genuine breaking
 * news headlines.
 */

const LOW_SIGNAL_PATTERNS: RegExp[] = [
  // Personal-essay / column formats
  /\binterview with\b/i,
  /\bi spent\b/i,
  /\bmy week\b/i,
  /\bmy day\b/i,

  // Opinion / commentary tags
  /\bopinion:/i,
  /\beditorial:/i,
  /\bcolumn:/i,
  /\bcommentary:/i,
  /\banalysis:/i,
  /\bperspective:/i,

  // Recap / weekly / explainer formats
  /\bthis week in\b/i,
  /\bweekly (?:wrap|recap|roundup|digest)\b/i,
  /\b(?:morning|evening) brief(?:ing)?\b/i,
  /\b(?:daily|weekly) (?:roundup|recap|digest|brief)\b/i,
  /\brecap:/i,
  /\bexplained:/i,
  /\bexplainer:/i,
  /\bhow to\b/i,

  // Podcast / video / livestream formats
  /\bpodcast\b/i,
  /\bvideo:/i,
  /\bwatch:/i,
  /\blive(?:stream)?:/i,

  // Listicles
  /\b\d+ (?:things|ways|reasons|tips|takeaways)\b/i,
]

/**
 * Returns true if the headline looks like a genuine breaking-news item that's
 * worth spending an LLM call on. Returns false for opinion pieces, recaps,
 * podcasts, listicles, and other low-signal shapes.
 */
export function isWorthyHeadline(headline: string | null | undefined): boolean {
  if (!headline) return false
  const trimmed = headline.trim()
  if (trimmed.length < 10) return false  // suspiciously short
  return !LOW_SIGNAL_PATTERNS.some(re => re.test(trimmed))
}
