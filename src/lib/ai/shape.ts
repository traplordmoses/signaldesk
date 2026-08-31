// House shape enforcement for generated drafts.
//
// The team's format is a one-liner:
//
//   🟣 JUST IN: <one crisp sentence of fact>
//
// One colored-circle tag, the label, one sentence. No category emoji after the
// tag, no context/stakes line, no prediction hook, no trailing hook emoji.
// Short posts perform better on X; follow-ups get threaded by hand.
//
// The prompt asks for this shape, but a prompt is a request, not a guarantee —
// the model drifts back toward the longer form, especially once approved-post
// few-shots are in play. So we also enforce it deterministically here. This is
// the last thing that touches draft text before it's stored and sent to Lark.

// Colored-circle alert tags, in canonical output form.
const TAG_GENERAL = '\u{1F7E3}'          // 🟣 politics, sports, finance, world
const TAG_TECH = '\u{26AA}\u{FE0F}'      // ⚪️ tech / science / AI
const TAG_WEATHER = '\u{1F32A}\u{FE0F}'  // 🌪️ weather & alerts

// Leading run of emoji + whitespace, e.g. "🟣⚾ " or "🟣🏛️ ". Includes the
// variation selector, ZWJ and skin-tone modifiers so multi-codepoint emoji
// (🏛️ = U+1F3DB U+FE0F) are consumed whole rather than leaving a stray VS16.
const LEAD_EMOJI_RUN =
  /^[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}]+/u

// Trailing emoji (plus any whitespace) — strips a dangling 🔮 / 🧐 / 📈 off a
// draft that never closed its sentence with punctuation.
const TRAIL_EMOJI_RUN =
  /[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}]+$/u

// Abbreviations whose period is NOT a sentence end. Needed because the token
// after them is usually capitalized ("vs. Uzbekistan", "Sen. Smith"), which
// otherwise looks exactly like a sentence boundary.
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon',
  'sen', 'rep', 'gov', 'pres', 'sec', 'gen', 'adm', 'col', 'lt', 'sgt', 'capt',
  'st', 'jr', 'sr', 'inc', 'corp', 'ltd', 'co', 'llc', 'plc',
  'vs', 'etc', 'approx', 'est', 'no', 'dept', 'univ', 'assn', 'bros',
  'ave', 'blvd', 'rd', 'mt', 'ft',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec',
]

// A single-letter token before the candidate period: an initial or one leg of
// a dotted acronym, never a sentence end. Covers both dots of "U.S." (the first
// is "the U." — a capital follows it, so it looks exactly like a boundary) plus
// "U.K.", "a.m.", "D.C.", "J. D. Vance". Matched against the text UP TO AND
// INCLUDING the candidate period.
const DOTTED_ACRONYM = /(?:^|[\s("'])(?:[A-Za-z]\.){1,}$/

/**
 * Index of the end of the first sentence in `text`, or -1 if it has no
 * sentence boundary. The returned index is inclusive of the punctuation.
 */
function firstSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '.' && ch !== '!' && ch !== '?') continue

    if (ch === '.') {
      // Decimal point: "4.81%", "0.05pt".
      if (/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) continue

      // Dotted acronym: "the U.S. has", "9 a.m. ET".
      if (DOTTED_ACRONYM.test(text.slice(0, i + 1))) continue

      // Known abbreviation: "vs. Uzbekistan", "Sen. Smith".
      const word = text.slice(0, i).match(/([A-Za-z]+)$/)?.[1]?.toLowerCase()
      if (word && ABBREVIATIONS.includes(word)) continue
    }

    // Look at what follows. A lowercase letter means the sentence continues
    // (an abbreviation we don't know about). Anything else — a capital, a
    // digit, an emoji, or end of string — ends it.
    const rest = text.slice(i + 1)
    if (rest.trim() === '') return i
    const next = rest.replace(/^\s+/, '')[0] ?? ''
    if (/\p{Ll}/u.test(next)) continue

    return i
  }
  return -1
}

/**
 * Trim a draft to the house one-liner: one colored tag, the label, one sentence.
 *
 * Idempotent — running it on already-shaped text returns that text unchanged,
 * which is what lets us also run it over stored approved posts before they're
 * used as few-shot examples.
 */
export function enforceOneLiner(content: string): string {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''

  // Split the leading emoji run off the body, and pick the tag out of it. An
  // unrecognized or missing tag falls back to 🟣 (the general-news default).
  const lead = text.match(LEAD_EMOJI_RUN)?.[0] ?? ''
  const body = text.slice(lead.length).trim()

  let tag = TAG_GENERAL
  if (lead.includes('\u{26AA}')) tag = TAG_TECH
  else if (lead.includes('\u{1F32A}')) tag = TAG_WEATHER

  // Keep only the first sentence of the body. No boundary means the model
  // wrote a single unterminated line — keep it, minus any trailing emoji.
  const end = firstSentenceEnd(body)
  const sentence = end === -1
    ? body.replace(TRAIL_EMOJI_RUN, '').trim()
    : body.slice(0, end + 1).trim()

  if (sentence === '') return tag
  return `${tag} ${sentence}`
}
