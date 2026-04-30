import { db } from './index'
import { newsSources, settings } from './schema'

export const DEFAULT_NEWS_SOURCES = [
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

  // Primary-source and breaking-data feeds
  { id: 'fed_press_all',     name: 'Federal Reserve Press Releases', url: 'https://www.federalreserve.gov/feeds/press_all.xml',      category: 'economics', weight: 10 },
  { id: 'fed_monetary',      name: 'Federal Reserve Monetary Policy', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', category: 'economics', weight: 10 },
  { id: 'fed_speeches',      name: 'Federal Reserve Speeches',        url: 'https://www.federalreserve.gov/feeds/speeches.xml',       category: 'economics', weight: 9  },
  { id: 'fed_testimony',     name: 'Federal Reserve Testimony',       url: 'https://www.federalreserve.gov/feeds/testimony.xml',      category: 'economics', weight: 9  },
  // sec_8k_current intentionally removed — even with item-number filtering,
  // 8-K filings (CEO changes, bankruptcies, M&A on individual public companies)
  // didn't map to the prediction-market audience the bot writes for. The cards
  // also tended to make the LLM hallucinate generic financial commentary in
  // the second sentence. If we want a financial-filings angle later, a more
  // targeted source (e.g. specific tickers being traded as Polymarket markets)
  // would be the right path.
  //
  // prnewswire_all intentionally removed for the same reason — same noise
  // shape as 8-Ks: the daily flood of corporate quarterly earnings press
  // releases ("Acme Corp announces Q1 2026 earnings", "Forum Markets
  // announces earnings call date", "BRC Group Holdings Q1 2026 earnings
  // call") drove low-signal cards and hallucinated analyst-style second
  // sentences. Real M&A / executive-departure / regulatory-action news
  // arrives via Reuters, AP, FT, Bloomberg etc. anyway.
  { id: 'cisa_kev',          name: 'CISA Known Exploited Vulnerabilities', url: 'signaldesk://cisa/kev',                              category: 'cyber',     weight: 9  },
  { id: 'nws_severe_alerts', name: 'National Weather Service Severe Alerts', url: 'signaldesk://nws/severe-alerts',                   category: 'weather',   weight: 8  },
  { id: 'usgs_quakes_sig',   name: 'USGS Significant Earthquakes',    url: 'signaldesk://usgs/significant-quakes',                   category: 'weather',   weight: 8  },
  { id: 'openfda_drug_recalls', name: 'openFDA Drug Recalls',         url: 'signaldesk://openfda/enforcement?kind=drug',              category: 'health',    weight: 8  },
  { id: 'openfda_device_recalls', name: 'openFDA Device Recalls',     url: 'signaldesk://openfda/enforcement?kind=device',            category: 'health',    weight: 8  },
  { id: 'openfda_food_recalls', name: 'openFDA Food Recalls',         url: 'signaldesk://openfda/enforcement?kind=food',              category: 'health',    weight: 8  },

  // Markets-driven news pull — uses the cached prediction-market topics
  // (Polymarket + Kalshi) to query Google News for recent articles on each
  // top-volume market's topic. Surfaces stories the RSS firehose might miss,
  // particularly niche-ticker / region-specific events that have active
  // markets but limited mainstream wire coverage.
  { id: 'markets_news_pull',  name: 'Markets Top-Topic News',          url: 'signaldesk://markets/google-news',                       category: 'economics', weight: 8  },

  // International + wire fallbacks (AP via feedx mirrors faster than Google News wrap)
  { id: 'feedx_ap',          name: 'AP via feedx',     url: 'https://feedx.net/rss/ap.xml',                          category: 'politics',  weight: 10 },
  { id: 'euronews',          name: 'Euronews',         url: 'https://www.euronews.com/rss',                          category: 'politics',  weight: 8  },
  { id: 'time_news',         name: 'Time',             url: 'https://time.com/feed/',                                category: 'politics',  weight: 7  },
  { id: 'scmp_world',        name: 'SCMP',             url: 'https://www.scmp.com/rss/91/feed/',                     category: 'politics',  weight: 9  },
  { id: 'cbc_top',           name: 'CBC Top Stories',  url: 'https://www.cbc.ca/webfeed/rss/rss-topstories',         category: 'politics',  weight: 8  },
  { id: 'toi_top',           name: 'Times of India',   url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', category: 'politics', weight: 8 },
  { id: 'nikkei_asia',       name: 'Nikkei Asia',      url: 'https://asia.nikkei.com/rss/feed/nar',                  category: 'economics', weight: 9  },
  { id: 'npr_politics',      name: 'NPR Politics',     url: 'https://feeds.npr.org/1014/rss.xml',                    category: 'politics',  weight: 8  },
  { id: 'bloomberg_markets', name: 'Bloomberg Markets',url: 'https://feeds.bloomberg.com/markets/news.rss',          category: 'economics', weight: 9  },

  // US government primary sources
  { id: 'whitehouse_actions',name: 'White House Presidential Actions', url: 'https://www.whitehouse.gov/presidential-actions/feed/', category: 'politics', weight: 10 },
  { id: 'congress_bills',    name: 'Congress.gov Most-Viewed Bills',   url: 'https://www.congress.gov/rss/most-viewed-bills.xml',    category: 'politics', weight: 8  },

  // Defense
  { id: 'breaking_defense',  name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/',                     category: 'politics',  weight: 8  },

  // Tech / cyber blogs (CISA KEV above is the official channel; these are faster-moving)
  { id: 'four04_media',      name: '404 Media',        url: 'https://www.404media.co/rss/',                          category: 'tech',      weight: 8  },
  { id: 'the_hacker_news',   name: 'The Hacker News',  url: 'https://feeds.feedburner.com/TheHackersNews',           category: 'cyber',     weight: 8  },
  { id: 'bleepingcomputer',  name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/',                category: 'cyber',     weight: 9  },
  { id: 'krebs_security',    name: 'Krebs on Security',url: 'https://krebsonsecurity.com/feed/',                     category: 'cyber',     weight: 9  },

  // Energy / utilities
  { id: 'utility_dive',      name: 'Utility Dive',     url: 'https://www.utilitydive.com/feeds/news/',               category: 'economics', weight: 7  },

  // Biotech / pharma
  { id: 'stat_news',         name: 'STAT News',        url: 'https://www.statnews.com/feed/',                        category: 'health',    weight: 9  },

  // Sports — non-ESPN coverage
  { id: 'the_athletic',      name: 'The Athletic',     url: 'https://www.nytimes.com/athletic/rss/news/',            category: 'sports',    weight: 9  },
  { id: 'sky_sports',        name: 'Sky Sports News',  url: 'https://www.skysports.com/rss/12040',                   category: 'sports',    weight: 8  },

  // Science / space
  { id: 'bbc_science',       name: 'BBC Science & Environment', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science', weight: 7 },
  { id: 'spacenews',         name: 'SpaceNews',        url: 'https://spacenews.com/feed/',                           category: 'science',   weight: 7  },

  // Entertainment + culture
  { id: 'variety',           name: 'Variety',                  url: 'https://variety.com/feed/',                                    category: 'entertainment', weight: 8 },
  { id: 'hollywood_rptr',    name: 'Hollywood Reporter',       url: 'https://www.hollywoodreporter.com/feed/',                      category: 'entertainment', weight: 8 },
  { id: 'deadline',          name: 'Deadline',                 url: 'https://deadline.com/feed/',                                   category: 'entertainment', weight: 9 },
  { id: 'tmz',               name: 'TMZ',                      url: 'https://www.tmz.com/rss.xml',                                  category: 'entertainment', weight: 9 },
  { id: 'page_six',          name: 'Page Six',                 url: 'https://pagesix.com/feed/',                                    category: 'entertainment', weight: 7 },
  { id: 'bbc_arts',          name: 'BBC Entertainment & Arts', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'entertainment', weight: 7 },

  // Music
  { id: 'billboard',         name: 'Billboard',        url: 'https://www.billboard.com/feed/',                       category: 'music',     weight: 7  },

  // Gaming
  { id: 'gamespot',          name: 'GameSpot News',    url: 'https://www.gamespot.com/feeds/news/',                  category: 'gaming',    weight: 7  },
] as const

export async function seedIfEmpty() {
  await syncDefaultSources()
}

export async function syncDefaultSources() {
  // Insert default news sources. Existing rows are left untouched so operators can
  // keep local enable/disable and weight settings across deploys.
  for (const source of DEFAULT_NEWS_SOURCES) {
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

  console.log(`[startup] default sources synced (${sourcesCount} news_sources, ${settingsCount} settings row)`)
}
