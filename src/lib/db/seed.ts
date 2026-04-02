import { db } from './index'
import { newsSources, settings } from './schema'

const sources = [
  { id: 'reuters_world',    name: 'Reuters World',    url: 'https://feeds.reuters.com/Reuters/worldNews',            category: 'politics',  weight: 10 },
  { id: 'reuters_politics', name: 'Reuters Politics', url: 'https://feeds.reuters.com/reuters/politicsNews',         category: 'politics',  weight: 9  },
  { id: 'guardian_world',   name: 'Guardian World',   url: 'https://www.theguardian.com/world/rss',                  category: 'politics',  weight: 8  },
  { id: 'ft_world',         name: 'FT World',         url: 'https://www.ft.com/world?format=rss',                    category: 'politics',  weight: 9  },
  { id: 'ft_economics',     name: 'FT Economics',     url: 'https://www.ft.com/economics?format=rss',                category: 'economics', weight: 10 },
  { id: 'ft_markets',       name: 'FT Markets',       url: 'https://www.ft.com/markets?format=rss',                  category: 'economics', weight: 10 },
  { id: 'reuters_business', name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews',         category: 'economics', weight: 9  },
  { id: 'cointelegraph',    name: 'CoinTelegraph',    url: 'https://cointelegraph.com/rss',                          category: 'crypto',    weight: 10 },
  { id: 'coindesk',         name: 'CoinDesk',         url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',        category: 'crypto',    weight: 10 },
  { id: 'decrypt',          name: 'Decrypt',          url: 'https://decrypt.co/feed',                                category: 'crypto',    weight: 8  },
  { id: 'espn_top',         name: 'ESPN Top News',    url: 'https://www.espn.com/espn/rss/news',                     category: 'sports',    weight: 10 },
  { id: 'bbc_sport',        name: 'BBC Sport',        url: 'https://feeds.bbci.co.uk/sport/rss.xml',                 category: 'sports',    weight: 8  },
  { id: 'techcrunch',       name: 'TechCrunch',       url: 'https://techcrunch.com/feed/',                           category: 'tech',      weight: 9  },
  { id: 'ars_technica',     name: 'Ars Technica',     url: 'https://feeds.arstechnica.com/arstechnica/index',        category: 'tech',      weight: 8  },
  { id: 'ft_tech',          name: 'FT Technology',    url: 'https://www.ft.com/technology?format=rss',               category: 'tech',      weight: 9  },

  // High-value additions for prediction market content
  { id: 'ap_top',           name: 'AP Top News',      url: 'https://feeds.apnews.com/rss/apf-topnews',               category: 'politics',  weight: 10 },
  { id: 'ap_politics',      name: 'AP Politics',      url: 'https://feeds.apnews.com/rss/apf-politics',              category: 'politics',  weight: 10 },
  { id: 'politico',         name: 'Politico',         url: 'https://www.politico.com/rss/politicopicks.xml',         category: 'politics',  weight: 9  },
  { id: 'the_hill',         name: 'The Hill',         url: 'https://thehill.com/feed/',                              category: 'politics',  weight: 8  },
  { id: 'aljazeera',        name: 'Al Jazeera',       url: 'https://www.aljazeera.com/xml/rss/all.xml',              category: 'politics',  weight: 9  },
  { id: 'bbc_world',        name: 'BBC World News',   url: 'https://feeds.bbci.co.uk/news/world/rss.xml',            category: 'politics',  weight: 9  },
  { id: 'axios',            name: 'Axios',            url: 'https://api.axios.com/feed/',                            category: 'politics',  weight: 9  },
  { id: 'the_block',        name: 'The Block',        url: 'https://www.theblock.co/rss.xml',                        category: 'crypto',    weight: 9  },
  { id: 'blockworks',       name: 'Blockworks',       url: 'https://blockworks.co/feed',                             category: 'crypto',    weight: 8  },
  { id: 'marketwatch',      name: 'MarketWatch',      url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'economics', weight: 8  },
  { id: 'axios_markets',    name: 'Axios Markets',    url: 'https://api.axios.com/feed/markets',                     category: 'economics', weight: 8  },
  { id: 'wired',            name: 'Wired',            url: 'https://www.wired.com/feed/rss',                         category: 'tech',      weight: 7  },
]

export async function seedIfEmpty() {
  const existing = db.select().from(newsSources).all()
  if (existing.length > 0) return  // already seeded
  await seed()
  console.log('[startup] DB seeded with default sources')
}

async function seed() {
  // Insert news sources (skip if already exist)
  for (const source of sources) {
    db.insert(newsSources)
      .values({ ...source, isActive: 1 })
      .onConflictDoNothing()
      .run()
  }

  // Insert settings singleton
  db.insert(settings)
    .values({
      id: 'singleton',
      platformName: 'SignalDesk',
      marketBaseUrl: 'https://yourplatform.com/markets',
      autoGenerateThreshold: 6.5,
      postCooldownMinutes: 15,
      dailyPostLimit: 20,
      larkEnabled: 1,
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run()

  // Print row counts
  const sourcesCount = db.select().from(newsSources).all().length
  const settingsCount = db.select().from(settings).all().length

  console.log('✅ Seed complete')
  console.log(`   news_sources: ${sourcesCount} rows`)
  console.log(`   settings:     ${settingsCount} row`)
}

seed().catch(console.error)
