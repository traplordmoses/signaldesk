const GEO_TAGS: Record<string, string[]> = {
  '🇺🇸 美国':   ['united states', 'u.s.', ' usa', 'american', 'washington', 'biden', 'trump', 'congress', 'white house', 'pentagon', 'federal reserve', 'wall street', 'new york'],
  '🇨🇳 中国':   ['china', 'chinese', 'beijing', 'xi jinping', 'ccp', 'pla', 'taiwan strait', 'shanghai'],
  '🇷🇺 俄罗斯': ['russia', 'russian', 'moscow', 'putin', 'kremlin', 'wagner'],
  '🇺🇦 乌克兰': ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'kharkiv', 'odesa'],
  '🇮🇷 伊朗':   ['iran', 'iranian', 'tehran', 'khamenei', 'irgc', 'persian'],
  '🇮🇱 以色列': ['israel', 'israeli', 'tel aviv', 'netanyahu', 'idf', 'gaza', 'west bank'],
  '🇪🇺 欧盟':   ['european union', ' eu ', 'ecb', 'brussels', 'eurozone', 'european commission'],
  '🇬🇧 英国':   [' uk ', 'britain', 'british', 'london', 'downing street', 'bank of england', 'boe'],
  '🌏 中东':    ['middle east', 'saudi arabia', 'riyadh', 'iraq', 'baghdad', 'syria', 'lebanon', 'hezbollah', 'hamas', 'houthi', 'yemen'],
  '🇩🇪 德国':   ['germany', 'german', 'berlin', 'bundesbank', 'scholz'],
  '🇯🇵 日本':   ['japan', 'japanese', 'tokyo', 'boj', 'bank of japan', 'nikkei'],
  '🇰🇷 韩国':   ['south korea', 'korean', 'seoul', 'yoon'],
}

const TOPIC_TAGS: Record<string, string[]> = {
  '🗳 选举':      ['election', 'ballot', 'primary', 'candidate', 'poll result', 'votes counted', 'runoff', 'referendum'],
  '💰 利率/央行': ['fed rate', 'fomc', 'interest rate', 'rate cut', 'rate hike', 'central bank', 'monetary policy', 'boe rate', 'ecb rate', 'inflation data', 'cpi report', 'jobs report'],
  '💥 军事/冲突': ['airstrike', 'military operation', 'troops', 'missile', 'drone attack', 'invasion', 'ceasefire', 'casualties', 'bombing'],
  '⚖️ 制裁/法律': ['sanctions', 'indicted', 'sec charges', 'doj', 'criminal charges', 'lawsuit', 'court ruling', 'impeach'],
  '🪙 加密':      ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'defi', 'nft', 'stablecoin', 'binance', 'coinbase', 'sec etf'],
  '🤖 AI':       ['artificial intelligence', ' ai ', 'openai', 'chatgpt', 'gpt', 'gemini', 'anthropic', 'nvidia', 'llm', 'machine learning'],
  '📊 宏观经济':  ['gdp', 'recession', 'unemployment', 'earnings report', 'ipo', 'merger', 'acquisition', 'tariff', 'trade war', 'default', 'bankruptcy'],
  '🛢 能源':      ['oil price', 'opec', 'crude', 'natural gas', 'lng', 'pipeline', 'energy crisis'],
  '🎵 娱乐':      ['music', 'album', 'grammy', 'oscar', 'emmy', 'film', 'movie', 'celebrity', 'spotify', 'artist', 'tour'],
  '🏆 体育':      ['championship', 'nfl', 'nba', 'world cup', 'super bowl', 'playoff', 'transfer', 'premier league', 'olympics', 'ufc'],
  '🏥 健康/医疗': ['fda approval', 'vaccine', 'pandemic', 'drug trial', 'clinical', 'who ', 'outbreak', 'public health'],
  '🌍 气候':      ['climate', 'emissions', 'carbon', 'cop ', 'renewable', 'net zero', 'wildfire', 'flood', 'drought'],
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
