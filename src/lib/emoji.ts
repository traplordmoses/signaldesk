// Category → on-theme emoji sets, so every post carries a SPECIFIC emoji (⚽, ₿,
// 🤖, 🎬, 🗳️) instead of only the generic colored-circle alert tag. The model was
// defaulting to just 🟣 because the category emoji was optional and it got no
// per-story steer; the generator now injects the right set for each draft.
//
// Sets are drawn from the prediction-market category taxonomy used across
// Polymarket / Kalshi / Manifold (emojis[0] is the lead/primary emoji). Keys
// cover BOTH the content categories detectCategory() returns AND the source
// categories stored on a cluster, so emojisForCategory() can resolve either.

export const CATEGORY_EMOJI: Record<string, string[]> = {
  // ── Sports & games (model picks the fitting one: ⚽ World Cup, 🏀 NBA, ⚾ MLB) ──
  sports: ['🏆', '⚽', '🏀', '🏈', '⚾', '🥇'],
  gaming: ['🎮', '🕹️', '👾', '🏆', '⚔️', '💀'],

  // ── Money ──
  economy_finance: ['📈', '💵', '🏦', '📉', '🐂', '🐻'],
  economics: ['📈', '💵', '🏦', '📉', '🐂', '🐻'],
  crypto: ['₿', '🪙', '🚀', '📈', '🐋', '💎'],

  // ── Tech & science ──
  tech_ai: ['🤖', '🧠', '💻', '⚡', '✨', '🛜'],
  tech: ['💻', '📱', '🤖', '⚙️', '🛜', '🚀'],
  science: ['🔬', '🧪', '🧬', '⚛️', '📡', '🩻'],
  health_science: ['🔬', '🩺', '🧬', '💊', '🧪', '🦠'],
  health: ['🩺', '💊', '🧬', '🦠', '🏥', '💉'],
  space: ['🚀', '🛰️', '🌌', '🪐', '🌕', '👨‍🚀'],
  cyber: ['🔒', '🕵️', '🛡️', '💻', '🚨', '🔓'],

  // ── Politics & world ──
  politics: ['🏛️', '🗳️', '🎩', '📜', '⚖️', '🤝'],
  elections: ['🗳️', '📊', '🟦', '🟥', '🏆', '🎤'],
  geopolitics: ['🌍', '🌐', '🤝', '🚩', '🕊️', '📡'],

  // ── Culture & internet ──
  pop_culture: ['🎬', '🍿', '🎤', '⭐', '📺', '🎵'],
  entertainment: ['🎬', '🍿', '🎤', '⭐', '📺', '🎭'],
  music: ['🎵', '🎤', '🎸', '💿', '🔥', '🏆'],
  mentions: ['💬', '🎤', '🗣️', '📢', '👀', '❓'],

  // ── Weather & climate ──
  weather: ['🌪️', '🌡️', '🌊', '🔥', '❄️', '🌍'],
}

// When neither the detected content category nor the source category is mapped,
// fall back to a neutral "stakes / curiosity" set so a post still gets a
// non-generic emoji rather than the bare colored circle.
const FALLBACK_EMOJI = ['📊', '🔮', '🧐', '👀', '🔥']

/**
 * Emoji palette for a story, preferring the finer detected content category,
 * then the source category, then a neutral fallback. The generator injects the
 * result into the prompt so the model leads with the right on-theme emoji.
 */
export function emojisForCategory(
  contentCategory: string | null | undefined,
  sourceCategory?: string | null,
): string[] {
  return (
    (contentCategory ? CATEGORY_EMOJI[contentCategory] : undefined) ??
    (sourceCategory ? CATEGORY_EMOJI[sourceCategory] : undefined) ??
    FALLBACK_EMOJI
  )
}
