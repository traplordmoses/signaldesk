import { db } from './index'
import { newsSources, settings } from './schema'
import { inArray } from 'drizzle-orm'

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
  // Al Jazeera down-weighted (10→7): a conflict-heavy wire whose front page skews
  // hard to war/geopolitics. Still on for coverage, but no longer earns the
  // full source-weight bonus that helped push conflict stories up the old ranking.
  { id: 'aljazeera',        name: 'Al Jazeera',       url: 'https://www.aljazeera.com/xml/rss/all.xml',              category: 'politics',  weight: 7  },
  { id: 'bbc_world',        name: 'BBC World News',   url: 'https://feeds.bbci.co.uk/news/world/rss.xml',            category: 'politics',  weight: 9  },
  { id: 'axios',            name: 'Axios',            url: 'https://api.axios.com/feed/',                            category: 'politics',  weight: 9  },
  { id: 'the_block',        name: 'The Block',        url: 'https://www.theblock.co/rss.xml',                        category: 'crypto',    weight: 9  },
  { id: 'blockworks',       name: 'Blockworks',       url: 'https://blockworks.co/feed',                             category: 'crypto',    weight: 8  },
  { id: 'marketwatch',      name: 'MarketWatch',      url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'economics', weight: 8  },
  { id: 'axios_markets',    name: 'Axios Markets',    url: 'https://api.axios.com/feed/markets',                     category: 'economics', weight: 8  },
  { id: 'wired',            name: 'Wired',            url: 'https://www.wired.com/feed/rss',                         category: 'tech',      weight: 7  },

  // Primary-source feeds (Fed = forward-looking, decidable macro events — on-brand)
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
  // releases drove low-signal cards and hallucinated analyst-style second
  // sentences. Real M&A / executive-departure / regulatory-action news
  // arrives via Reuters, AP, FT, Bloomberg etc. anyway.
  //
  // ── Retired "doom" ingestion adapters ──────────────────────────────────────
  // The CISA exploited-vulnerabilities, NWS severe-weather-alerts, USGS
  // significant-earthquakes, and openFDA drug/device/food recall adapters used
  // to seed here. They produce pure-negative signal that doesn't fit Probly's
  // optimistic, market-driven feed, so they've been removed from the default set
  // and are force-disabled on existing DBs (see RETIRED_SOURCE_IDS below). The
  // adapter code still lives in fetcher.ts — re-enabling is just re-adding a row.
  // Disaster stories with a genuinely active market still arrive via the
  // markets-driven Google News pull below.

  // Markets-driven news pull — uses the cached prediction-market topics
  // (Polymarket + Kalshi) to query Google News for recent articles on each
  // top-volume market's topic. This is the MOST on-brand source: it surfaces
  // exactly the stories with live markets, so it's weighted at the top (8→10).
  { id: 'markets_news_pull',  name: 'Markets Top-Topic News',          url: 'signaldesk://markets/google-news',                       category: 'economics', weight: 10 },

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

  // Defense — down-weighted (8→6): conflict-skewed; keep for coverage, drop the bonus.
  { id: 'breaking_defense',  name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/',                     category: 'politics',  weight: 6  },

  // Tech / cyber blogs — down-weighted (breach/exploit doom rarely maps to a
  // Probly market). Kept active for the occasional big story, but below the
  // source-weight bonus threshold so they don't get nudged up the ranking.
  { id: 'four04_media',      name: '404 Media',        url: 'https://www.404media.co/rss/',                          category: 'tech',      weight: 6  },
  { id: 'the_hacker_news',   name: 'The Hacker News',  url: 'https://feeds.feedburner.com/TheHackersNews',           category: 'cyber',     weight: 6  },
  { id: 'bleepingcomputer',  name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/',                category: 'cyber',     weight: 6  },
  { id: 'krebs_security',    name: 'Krebs on Security',url: 'https://krebsonsecurity.com/feed/',                     category: 'cyber',     weight: 6  },

  // Energy / utilities
  { id: 'utility_dive',      name: 'Utility Dive',     url: 'https://www.utilitydive.com/feeds/news/',               category: 'economics', weight: 7  },

  // Biotech / pharma (FDA approvals etc. — the upside side of health news)
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

// Sources whose rows we keep for history but force inactive: the retired "doom"
// adapters (exploits, severe weather, quakes, recalls). Listed by id so the
// deactivation also reaches DBs that were seeded before they were retired.
const RETIRED_SOURCE_IDS: string[] = [
  'cisa_kev',
  'nws_severe_alerts',
  'usgs_quakes_sig',
  'openfda_drug_recalls',
  'openfda_device_recalls',
  'openfda_food_recalls',
]

export async function seedIfEmpty() {
  await syncDefaultSources()
}

export async function syncDefaultSources() {
  // weight + category are MANAGED here: re-applied on every boot so a rebalance
  // actually reaches a long-running DB. (The previous onConflictDoNothing meant
  // edits to this list never propagated past a fresh install.) is_active stays
  // under operator control — except the retired adapters below, forced off.
  for (const source of DEFAULT_NEWS_SOURCES) {
    db.insert(newsSources)
      .values({ ...source, isActive: 1 })
      .onConflictDoUpdate({
        target: newsSources.id,
        set: { weight: source.weight, category: source.category },
      })
      .run()
  }

  // Force-retire the doom adapters (keep the rows for history; just disable).
  const retired = db.update(newsSources)
    .set({ isActive: 0 })
    .where(inArray(newsSources.id, RETIRED_SOURCE_IDS))
    .run()

  // Settings singleton — threshold stays 6.5 (backtest-supported). Left untouched
  // on existing DBs so operator tuning survives.
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

  const sourcesCount = db.select().from(newsSources).all().length
  const settingsCount = db.select().from(settings).all().length

  console.log(`[startup] sources synced (${sourcesCount} news_sources, ${settingsCount} settings row; ${retired.changes} doom adapter(s) retired)`)
}
