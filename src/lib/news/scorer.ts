/**
 * News scoring — redesigned to mirror Polymarket's market universe and frame
 * everything through an optimistic, "before it happens" lens.
 *
 * The score is a clamped sum of signals:
 *   MarketFit    0..+5    does the headline map to a live, actively-traded
 *                         Polymarket/Kalshi market? (the SPINE — see ../markets)
 *   CategoryFit  0..+3    which Polymarket category does it fall in?
 *   Anticipation 0..+2    forward-looking, decidable "before it happens" framing
 *   Valence     -6..+2    optimism reward / soft-negative / gore penalty
 *   Source       0..+1    feed credibility
 *   Ticker       0..+1.5  priority company / asset mention
 *   Recency      0..+0.5  small freshness nudge (deliberately small)
 *
 * Ceiling = 10 when the story maps to a live market OR hits a marquee category
 * (sports / crypto / tech / culture); otherwise 8. This replaces the old
 * "crisis keyword unlocks 10" rule — now it's live-market relevance + on-brand
 * upside that earns the top of the range, not war / indictment keywords.
 *
 * Negativity is no longer an emergent reward. Gore is penalised (and still
 * hard-skipped by detectRisk), but the geopolitics TOPIC is kept: a neutral
 * "Will Russia capture Sumy?" market question retains its category + market
 * score, while "40 killed in Sumy strike" is docked into the floor.
 */

// ── Polymarket category taxonomy ────────────────────────────────────────────
// Scanned from the Gamma API (tags + top events) + site nav on 2026-06-19.
// `weight` is the CategoryFit contribution (max across matched categories).
// `marquee` categories (the most on-brand, optimistic, high-energy buckets)
// unlock the 10 ceiling on their own.
interface Category {
  name: string
  weight: number
  marquee: boolean
  keywords: string[]
}

const CATEGORIES: Category[] = [
  {
    name: 'sports', weight: 3, marquee: true,
    keywords: [
      'world cup', 'fifa', 'champions league', 'europa league', 'premier league',
      'la liga', 'ballon d\'or', 'super bowl', 'playoffs', 'finals', 'semifinal',
      'quarterfinal', 'world series', 'stanley cup', 'nba', 'nfl', 'mlb', 'nhl',
      'olympics', 'grand slam', 'wimbledon', 'us open', 'ufc', 'heavyweight',
      'knockout', 'grand prix', 'formula 1', 'cricket', 'transfer window',
      'qualifier', 'championship', 'world champion', 'esports', 'medal',
    ],
  },
  {
    name: 'crypto', weight: 3, marquee: true,
    keywords: [
      'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'xrp', 'ripple', 'dogecoin',
      'altcoin', 'stablecoin', 'usdc', 'tether', 'crypto', 'cryptocurrency',
      'defi', 'airdrop', 'memecoin', 'bitcoin etf', 'halving', 'coinbase',
      'binance', 'kraken', 'blockchain',
    ],
  },
  {
    name: 'tech_ai', weight: 3, marquee: true,
    keywords: [
      'openai', 'anthropic', 'claude', 'chatgpt', 'gpt-', 'gpt-5', 'gemini',
      'deepseek', 'mistral', 'grok', 'xai', 'artificial intelligence', 'ai model',
      'ai race', 'machine learning', 'spacex', 'starship', 'rocket launch',
      'nvidia', 'semiconductor', 'quantum computing', 'product launch', 'launches',
      'unveils', 'ipo', 'goes public', 'iphone', 'apple', 'microsoft', 'google',
      'alphabet', 'meta', 'tesla', 'amazon', 'gta vi', 'release date', 'keynote',
      'robotaxi',
    ],
  },
  {
    name: 'pop_culture', weight: 3, marquee: true,
    keywords: [
      'box office', 'opening weekend', 'premiere', 'sequel', 'reboot', 'trailer',
      'blockbuster', 'oscars', 'academy award', 'grammys', 'golden globe',
      'billboard', 'number one', 'chart-topping', 'album', 'world tour',
      'taylor swift', 'beyonce', 'celebrity', 'season finale', 'netflix',
      'disney', 'marvel', 'mrbeast', 'goes viral', 'streaming record',
    ],
  },
  {
    name: 'economy_finance', weight: 2, marquee: false,
    keywords: [
      'fed', 'federal reserve', 'fomc', 'rate cut', 'rate hike', 'rate decision',
      'interest rate', 'inflation', 'cpi report', 'jobs report', 'gdp', 'earnings',
      'guidance', 's&p 500', 'nasdaq', 'dow jones', 'gold', 'silver', 'crude oil',
      'oil price', 'commodities', 'treasury yield', 'jackson hole', 'recession',
      'unemployment', 'tariff', 'trade deal', 'fda approval', 'acquisition', 'merger',
    ],
  },
  {
    name: 'elections', weight: 2, marquee: false,
    keywords: [
      'election', 'primary', 'caucus', 'midterm', 'midterms', 'ballot', 'nominee',
      'nomination', 'governor race', 'senate race', 'presidential race', 'runoff',
      'general election', 'electoral', 'polling',
    ],
  },
  {
    name: 'politics', weight: 2, marquee: false,
    keywords: [
      'congress', 'senate', 'white house', 'supreme court', 'scotus', 'impeach',
      'impeachment', 'pardon', 'cabinet', 'speaker', 'filibuster', 'legislation',
      'prime minister', 'parliament', 'president',
    ],
  },
  {
    name: 'geopolitics', weight: 2, marquee: false,
    keywords: [
      'iran', 'israel', 'ukraine', 'russia', 'china', 'taiwan', 'gaza', 'lebanon',
      'syria', 'nato', 'putin', 'zelensky', 'netanyahu', 'strait of hormuz',
      'ceasefire', 'peace deal', 'sanctions', 'treaty', 'diplomatic', 'summit',
      'foreign policy', 'normalize relations', 'middle east', 'uranium', 'enrichment',
    ],
  },
  {
    name: 'mentions', weight: 2, marquee: false,
    keywords: ['elon musk', 'tweet', 'tweets'],
  },
  {
    name: 'weather', weight: 2, marquee: false,
    keywords: [
      'temperature', 'heat wave', 'highest temperature', 'record heat', 'snowstorm',
      'rainfall', 'tornado', 'hurricane', 'typhoon', 'cyclone', 'blizzard', 'wildfire',
      'flood', 'flash flood', 'earthquake', 'magnitude', 'severe storm', 'tsunami',
      'heat dome', 'cold snap',
    ],
  },
  {
    name: 'health_science', weight: 2, marquee: false,
    keywords: [
      'fda approval', 'clinical trial', 'vaccine', 'outbreak', 'pandemic', 'virus',
      'disease', 'cdc', 'breakthrough', 'gene therapy', 'crispr', 'medical', 'cancer',
      'measles', 'bird flu', 'alzheimer', 'obesity drug', 'ozempic',
    ],
  },
  {
    name: 'space', weight: 3, marquee: true,
    keywords: [
      'nasa', 'rocket launch', 'satellite', 'mars', 'moon landing', 'lunar', 'asteroid',
      'space station', 'spacewalk', 'telescope', 'orbit', 'astronaut', 'spacex', 'starship',
    ],
  },
  {
    name: 'gaming', weight: 2, marquee: false,
    keywords: [
      'video game', 'gta', 'playstation', 'xbox', 'nintendo', 'steam', 'twitch',
      'esports', 'game release', 'console', 'speedrun', 'fortnite', 'minecraft',
    ],
  },
  {
    name: 'cyber', weight: 2, marquee: false,
    keywords: [
      'exploit', 'vulnerability', 'cve', 'zero-day', 'zero day', 'data breach', 'hacked',
      'ransomware', 'malware', 'security flaw', 'known exploited', 'kev catalog',
      'cyberattack', 'cracked', 'phishing',
    ],
  },
]

// ANTICIPATION — forward-looking, decidable "before it happens" framing. The
// brand's whole thesis, rewarded directly. +1 per distinct phrase, cap +2.
const ANTICIPATION = [
  'will win', 'will hit', 'will reach', 'set to', 'on track to', 'poised to',
  'expected to', 'to launch', 'to release', 'to unveil', 'upcoming', 'ahead of',
  'this week', 'this weekend', 'this season', 'next week', 'next month',
  'countdown', 'days away', 'kicks off', 'kickoff', 'release date', 'set for',
  'by june', 'by july', 'by august', 'by december', 'by end of', 'in 2026',
  'in 2027', 'preview', 'forecast', 'odds', 'predict', 'prediction', 'slated',
]

// POSITIVE — optimism / upside. Includes de-escalation terms (ceasefire, peace,
// normalize) so the *hopeful* angle on a geopolitics market is rewarded. +1 per
// distinct hit, cap +2.
const POSITIVE = [
  'wins', 'win', 'won', 'victory', 'champion', 'record high', 'all-time high',
  'record', 'milestone', 'breakthrough', 'launch', 'launches', 'unveils', 'debut',
  'approved', 'approval', 'deal', 'agreement', 'agrees', 'partnership', 'ceasefire',
  'peace', 'truce', 'normalize', 'reopens', 'comeback', 'surges', 'soars', 'rally',
  'historic', 'first ever', 'breaks record', 'hits high', 'beats', 'rebounds',
]

// SOFT_NEGATIVE — doom / alarm / active-conflict framing. Dampens the score
// (applied once, -2) so that on the SAME topic the neutral or de-escalation
// angle outranks the doom angle — we keep the geopolitics market but let its
// hopeful framing win. Casualties are handled harder, separately, by GORE.
const SOFT_NEGATIVE = [
  // market / institutional doom
  'crash', 'crashes', 'plunge', 'plunges', 'plummet', 'slump', 'collapse',
  'scandal', 'crisis', 'probe', 'lawsuit', 'sued', 'fraud', 'banned', 'outage',
  'fears', 'warns', 'warning', 'threat', 'turmoil', 'recall', 'ecocide',
  'backlash', 'slammed',
  // active-conflict framing (no casualties — those are GORE)
  'war', 'at war', 'airstrike', 'attack', 'attacks', 'invasion',
  'offensive', 'clash', 'clashes', 'escalation', 'escalates', 'missile',
  'drone strike', 'bombard', 'siege', 'warfare',
]

// GORE — graphic violence / loss of life. Applied once (-4) AND hard-skipped by
// detectRisk (TRAGEDY). The penalty here ensures gore framing ranks at the floor
// even before the skip gate — without touching the geopolitics topic itself.
const GORE = [
  'killed', 'kills', 'dead', 'death', 'deaths', 'casualties', 'fatalities',
  'massacre', 'shooting', 'slaughter', 'atrocity', 'bodies', 'beheading',
  'murdered', 'murder', 'genocide', 'mass grave', 'execution', 'victims',
]

// Priority companies + indices the audience cares about during earnings
// season and big macro days. Headlines mentioning any of these get a +1.5
// score bump on top of the base scoring. Both common names ("apple",
// "microsoft") and tickers ("aapl", "msft") are listed because news
// headlines mix the two interchangeably. Keep the list tight — adding
// the entire S&P 500 here would dilute the signal.
const PRIORITY_TICKERS = [
  // mag7
  'apple', 'aapl',
  'microsoft', 'msft',
  'google', 'alphabet', 'googl', 'goog',
  'amazon', 'amzn',
  'meta', 'facebook',
  'tesla', 'tsla',
  'nvidia', 'nvda',

  // big tech beyond mag7
  'amd',
  'oracle', 'orcl',
  'salesforce',
  'netflix', 'nflx',
  'intel', 'intc',
  'palantir', 'pltr',
  'broadcom', 'avgo',

  // big banks
  'jpmorgan', 'jpm',
  'goldman sachs', 'goldman',
  'bank of america',
  'wells fargo',
  'morgan stanley',
  'citigroup', 'citi',

  // defense / oil / industrials
  'lockheed martin',
  'raytheon', 'rtx',
  'boeing', 'ba',
  'exxon', 'xom',
  'chevron', 'cvx',

  // indices
  's&p 500', 'sp500', 'nasdaq', 'dow jones', 'russell 2000',

  // crypto majors
  'bitcoin', 'btc',
  'ethereum', 'eth',
  'solana', 'sol',
]

// TRAGEDY — auto-skip from generation. Keep this list narrow and unambiguous:
// the bot must NEVER auto-write competing content during an active tragedy.
// Keywords picked so they almost always indicate literal violence or loss of
// life in news headlines (false positives like "killed it on stage" are
// vanishingly rare in actual breaking-news writing).
const TRAGEDY = [
  'killed', 'casualties', 'victims', 'fatalities',
  'shooting', 'bombing',
  'terror', 'terrorist',
  'hostage', 'massacre',
  'murder', 'murdered',
]

// LOCAL_CRIME — routine local crime stories (Hong Kong burglaries, drug busts,
// muggings) leaked through to cards in the May 5 review because the markets-
// boost + source-weight + recency stack pushed them past the auto-generate
// threshold. These are not prediction-market relevant. Each match deducts a
// flat penalty from the final score so a single LOCAL_CRIME hit drops a
// borderline story below the threshold without killing legitimate big stories
// that ALSO map to a live market or marquee category.
//
// Kept narrow on purpose: 'shooting' / 'bombing' / 'casualties' stay in the
// TRAGEDY auto-skip list above. LOCAL_CRIME covers property crime + small-
// scale drug enforcement only. Solo 'heroin' / 'cocaine' are excluded because
// they appear in legitimate trafficking-policy and overdose-epidemic stories.
const LOCAL_CRIME = [
  'burglary', 'burglar',
  'robbery',
  'mugging', 'mugged',
  'carjacking',
  'drug bust', 'drug raid', 'narcotics raid',
  'heroin bust', 'cocaine bust', 'cocaine seizure',
  'arson',
  'vandalism', 'vandalized',
  'shoplifting',
  'pickpocket',
  'home invasion',
]
const LOCAL_CRIME_PENALTY = 3

// HIGH_STAKES — show ⚠️ warning on the review card but still generate. These
// are legitimate prediction-market-relevant breaking stories (Iran nuclear
// talks, Trump indictments, DOJ moves, SEC charges, election results) that
// the bot exists precisely to surface. Previously they were auto-skipped,
// which meant the King Charles "nuclear weapon ban" cluster — a textbook
// high-stakes geopolitical story — got blocked by the same "nuclear"
// keyword that was simultaneously boosting it to the top of the score list.
// Reviewer judgement is the right gate here, not a hard block.
const HIGH_STAKES = [
  // legal / DOJ / financial enforcement
  'doj', 'sec charges', 'criminal', 'indicted', 'arrested',
  'lawsuit', 'legal', 'conviction', 'guilty verdict',

  // geopolitical high-stakes (newsworthy, rarely tragic in framing)
  'nuclear', 'sanctions', 'assassination', 'attack',

  // sensitive but routine in news: prefer human review over auto-skip
  'death',

  // cyber / public-health alerts: relevant but should still be reviewed
  'data breach', 'cyberattack', 'kev catalog', 'class i recall',

  // political heat (kept from the old MEDIUM_RISK list)
  'political', 'election', 'controversy', 'scandal', 'protest',
  'conflict',
]

// Word-boundary keyword matching. `text.includes('doj')` would hit any string
// containing the substring "doj" — including unrelated words. This builds a regex
// per keyword that requires non-word chars (or string boundaries) on either side,
// while still allowing multi-word keywords like "rate cut" to match across spaces.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const WORD_RE_CACHE = new Map<string, RegExp>()
function wordBoundaryMatch(text: string, kw: string): boolean {
  let re = WORD_RE_CACHE.get(kw)
  if (!re) {
    re = new RegExp(`(?:^|\\W)${escapeRegex(kw)}(?:$|\\W)`, 'i')
    WORD_RE_CACHE.set(kw, re)
  }
  return re.test(text)
}

// Count distinct keyword hits, short-circuiting once we reach `cap`.
function countHits(text: string, keywords: string[], cap: number): number {
  let n = 0
  for (const kw of keywords) {
    if (wordBoundaryMatch(text, kw)) {
      n++
      if (n >= cap) return cap
    }
  }
  return n
}

function anyHit(text: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (wordBoundaryMatch(text, kw)) return true
  }
  return false
}

// Cap on the final score for stories that don't map to a live market AND don't
// hit a marquee category. Without this, common-English keyword hits compound
// with the source-weight + ticker + recency stack and push niche stories
// (game reviews, food essays, op-eds) into the 9-10 band. A live-market match
// or a marquee category (sports / crypto / tech / culture) is what should earn
// the top of the range.
const NO_MARQUEE_SCORE_CAP = 8.0

export function scoreItem(title: string, summary: string, weight: number, publishedAt: number): number {
  const text = (title + ' ' + (summary ?? '')).toLowerCase()

  // 1) Category fit — the single strongest Polymarket category (max weight).
  //    Track whether any matched category is marquee (for the ceiling rule).
  let categoryFit = 0
  let marquee = false
  for (const cat of CATEGORIES) {
    if (anyHit(text, cat.keywords)) {
      if (cat.weight > categoryFit) categoryFit = cat.weight
      if (cat.marquee) marquee = true
    }
  }

  // 2) Anticipation — forward-looking framing, +1 per phrase, cap +2.
  const anticipation = countHits(text, ANTICIPATION, 2)

  // 3) Valence — optimism reward minus soft-negative / gore penalties.
  let valence = countHits(text, POSITIVE, 2)
  if (anyHit(text, SOFT_NEGATIVE)) valence -= 2
  if (anyHit(text, GORE)) valence -= 4

  // 4) Source credibility.
  let source = 0
  if (weight >= 9) source = 1.0
  else if (weight >= 7) source = 0.5

  // 5) Priority-ticker bonus — one per article. Skipped when a marquee category
  //    already matched: crypto / big-tech tickers are already rewarded by their
  //    category (+3), so adding +1.5 just saturates the top of the range. This
  //    keeps the bonus meaningful for non-marquee names (banks, defense, oil).
  let ticker = 0
  if (!marquee) {
    for (const t of PRIORITY_TICKERS) {
      if (wordBoundaryMatch(text, t)) { ticker = 1.5; break }
    }
  }

  // 6) Recency — deliberately small. A "before it happens" brand rewards
  //    decidable upcoming outcomes, not who broke the story first.
  const ageHours = (Date.now() - publishedAt) / 3_600_000
  const recency = ageHours < 2 ? 0.5 : 0

  // 7) Market fit — THE SPINE. Does the headline map to a live, actively-traded
  //    Polymarket / Kalshi market? Flat bonus for any match + volume scaling
  //    (0..+5), and unlocks the 10 ceiling. Lazy-required (relative path) to
  //    avoid a circular import and to fail safe before the markets table exists.
  let marketBoost = 0
  let marketMatched = false
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marketFit } = require('../markets') as typeof import('../markets')
    const fit = marketFit(title, summary)
    marketBoost = fit.boost
    marketMatched = fit.matched
  } catch {
    // markets module not available — no market signal, continue
  }

  let score = categoryFit + anticipation + valence + source + ticker + recency + marketBoost

  // Local-crime penalty — applied AFTER all bonuses so it docks the final
  // composite score. Capped at one penalty per article.
  if (anyHit(text, LOCAL_CRIME)) score -= LOCAL_CRIME_PENALTY

  // Ceiling: a live-market match OR a marquee on-brand category earns 10;
  // everything else caps at 8.
  const ceiling = (marketMatched || marquee) ? 10 : NO_MARQUEE_SCORE_CAP
  return Math.min(ceiling, Math.max(0, score))
}

export function detectRisk(text: string): { level: 'low' | 'medium' | 'high'; reasons: string[] } {
  const lower = text.toLowerCase()
  const reasons: string[] = []

  // Tier 1: tragedy → auto-skip
  for (const kw of TRAGEDY) {
    if (wordBoundaryMatch(lower, kw)) reasons.push(kw)
  }
  if (reasons.length > 0) return { level: 'high', reasons }

  // Tier 2: high-stakes news → warn-only, still generates
  for (const kw of HIGH_STAKES) {
    if (wordBoundaryMatch(lower, kw)) reasons.push(kw)
  }
  if (reasons.length > 0) return { level: 'medium', reasons }

  return { level: 'low', reasons: [] }
}

// Topical keywords used by the clusterer to detect that two articles cover the
// same story (2+ shared keywords → same cluster). A flat, deduped list of all
// category keywords plus priority tickers. (Export name retained for the
// existing clusterer import contract.)
let CLUSTER_KEYWORDS: string[] | null = null
export function getTier1And2Keywords(): string[] {
  if (!CLUSTER_KEYWORDS) {
    const set = new Set<string>()
    for (const cat of CATEGORIES) for (const kw of cat.keywords) set.add(kw)
    for (const t of PRIORITY_TICKERS) set.add(t)
    CLUSTER_KEYWORDS = [...set]
  }
  return CLUSTER_KEYWORDS
}
