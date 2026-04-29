const GEO_TAGS: Record<string, string[]> = {
  '🇺🇸 United States': ['united states', 'u.s.', ' usa', 'american', 'washington', 'biden', 'trump', 'congress', 'white house', 'pentagon', 'federal reserve', 'wall street', 'new york'],
  '🇨🇳 China':         ['china', 'chinese', 'beijing', 'xi jinping', 'ccp', 'pla', 'taiwan strait', 'shanghai'],
  '🇷🇺 Russia':        ['russia', 'russian', 'moscow', 'putin', 'kremlin', 'wagner'],
  '🇺🇦 Ukraine':       ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'kharkiv', 'odesa'],
  '🇮🇷 Iran':          ['iran', 'iranian', 'tehran', 'khamenei', 'irgc', 'persian'],
  '🇮🇱 Israel':        ['israel', 'israeli', 'tel aviv', 'netanyahu', 'idf', 'gaza', 'west bank'],
  '🇪🇺 European Union': ['european union', ' eu ', 'ecb', 'brussels', 'eurozone', 'european commission'],
  '🇬🇧 United Kingdom': [' uk ', 'britain', 'british', 'london', 'downing street', 'bank of england', 'boe'],
  '🌏 Middle East':    ['middle east', 'saudi arabia', 'riyadh', 'iraq', 'baghdad', 'syria', 'lebanon', 'hezbollah', 'hamas', 'houthi', 'yemen'],
  '🇩🇪 Germany':       ['germany', 'german', 'berlin', 'bundesbank', 'scholz'],
  '🇯🇵 Japan':         ['japan', 'japanese', 'tokyo', 'boj', 'bank of japan', 'nikkei'],
  '🇰🇷 South Korea':   ['south korea', 'korean', 'seoul', 'yoon'],
}

const TOPIC_TAGS: Record<string, string[]> = {
  '🗳 Elections':       ['election', 'ballot', 'primary', 'candidate', 'poll result', 'votes counted', 'runoff', 'referendum'],
  '💰 Rates/Central Banks': ['fed rate', 'fomc', 'interest rate', 'rate cut', 'rate hike', 'central bank', 'monetary policy', 'boe rate', 'ecb rate', 'inflation data', 'cpi report', 'jobs report'],
  '💥 Military/Conflict': ['airstrike', 'military operation', 'troops', 'missile', 'drone attack', 'invasion', 'ceasefire', 'casualties', 'bombing'],
  '⚖️ Sanctions/Legal': ['sanctions', 'indicted', 'sec charges', 'doj', 'criminal charges', 'lawsuit', 'court ruling', 'impeach'],
  '🪙 Crypto':          ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'defi', 'nft', 'stablecoin', 'binance', 'coinbase', 'sec etf'],
  '🤖 AI':              ['artificial intelligence', ' ai ', 'openai', 'chatgpt', 'gpt', 'gemini', 'anthropic', 'nvidia', 'llm', 'machine learning'],
  '📊 Macro':           ['gdp', 'recession', 'unemployment', 'earnings report', 'ipo', 'merger', 'acquisition', 'tariff', 'trade war', 'default', 'bankruptcy'],
  '🛢 Energy':          ['oil price', 'opec', 'crude', 'natural gas', 'lng', 'pipeline', 'energy crisis'],
  '🎵 Entertainment':   ['music', 'album', 'grammy', 'oscar', 'emmy', 'film', 'movie', 'celebrity', 'spotify', 'artist', 'tour'],
  '🏆 Sports':          ['championship', 'nfl', 'nba', 'world cup', 'super bowl', 'playoff', 'transfer', 'premier league', 'olympics', 'ufc'],
  '🏥 Health/Medical':  ['fda approval', 'fda recall', 'recall', 'class i', 'class ii', 'vaccine', 'pandemic', 'drug trial', 'clinical', 'who ', 'outbreak', 'public health'],
  '🌍 Climate':         ['climate', 'emissions', 'carbon', 'cop ', 'renewable', 'net zero', 'wildfire', 'flood', 'drought'],
  '🛡 Cybersecurity':   ['cisa', 'known exploited vulnerability', 'kev catalog', 'cve', 'vulnerability', 'exploit', 'cyberattack', 'data breach', 'ransomware'],
  '🌪 Severe Weather':  ['tornado warning', 'hurricane warning', 'severe thunderstorm warning', 'flash flood warning', 'earthquake', 'emergency alert'],
}

export function extractTopics(title: string, summary: string): string[] {
  const text = (title + ' ' + (summary ?? '')).toLowerCase()
  const found: string[] = []

  for (const [tag, keywords] of Object.entries(GEO_TAGS)) {
    if (keywords.some(kw => text.includes(kw))) {
      found.push(tag)
      if (found.filter(t => t.includes('🇺🇸') || t.includes('🇨🇳') || t.includes('🇷🇺') || t.includes('🌏') || t.includes('🇮🇷') || t.includes('🇮🇱') || t.includes('🇪🇺') || t.includes('🇬🇧') || t.includes('🇩🇪') || t.includes('🇯🇵') || t.includes('🇰🇷') || t.includes('🇺🇦')).length >= 2) break
    }
  }

  for (const [tag, keywords] of Object.entries(TOPIC_TAGS)) {
    if (keywords.some(kw => text.includes(kw))) {
      found.push(tag)
    }
  }

  // Deduplicate and limit to 4 most relevant tags
  return [...new Set(found)].slice(0, 4)
}
