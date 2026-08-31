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
  { id: 'politico',         name: 'Politico',         url: 'https://rss.politico.com/politics-news.xml',              category: 'politics',  weight: 9  },
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
  // ── Event / alert adapters ─────────────────────────────────────────────────
  // Re-enabled to match the live @ProblyHQ feed, which posts 🌪️ weather alerts,
  // ⚪️ security/exploit news, and disaster/health stories. (Briefly retired during
  // the "optimistic only" pass.) Gore is still floored by the scorer's GORE /
  // TRAGEDY guards — we keep the feed and block casualties, not the other way around.
  { id: 'cisa_kev',          name: 'CISA Known Exploited Vulnerabilities', url: 'signaldesk://cisa/kev',                              category: 'cyber',     weight: 8  },
  { id: 'nws_severe_alerts', name: 'National Weather Service Severe Alerts', url: 'signaldesk://nws/severe-alerts',                   category: 'weather',   weight: 8  },
  { id: 'usgs_quakes_sig',   name: 'USGS Significant Earthquakes',    url: 'signaldesk://usgs/significant-quakes',                   category: 'weather',   weight: 7  },
  { id: 'openfda_drug_recalls', name: 'openFDA Drug Recalls',         url: 'signaldesk://openfda/enforcement?kind=drug',              category: 'health',    weight: 7  },
  { id: 'openfda_device_recalls', name: 'openFDA Device Recalls',     url: 'signaldesk://openfda/enforcement?kind=device',            category: 'health',    weight: 7  },
  { id: 'openfda_food_recalls', name: 'openFDA Food Recalls',         url: 'signaldesk://openfda/enforcement?kind=food',              category: 'health',    weight: 7  },

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
  { id: 'cbc_top',           name: 'CBC Top Stories',  url: 'https://rss.cbc.ca/lineup/topstories.xml',               category: 'politics',  weight: 8  },
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
  { id: 'cbs_sports',        name: 'CBS Sports',       url: 'https://www.cbssports.com/rss/headlines/',              category: 'sports',    weight: 8  },
  { id: 'fox_sports',        name: 'Fox Sports',       url: 'https://moxie.foxnews.com/google-publisher/sports.xml', category: 'sports',    weight: 7  },

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

  // Breadth toward the target mix (NA / Europe — culture, gaming, tech, science)
  { id: 'rolling_stone',     name: 'Rolling Stone',    url: 'https://www.rollingstone.com/feed/',                    category: 'entertainment', weight: 8 },
  { id: 'the_verge',         name: 'The Verge',        url: 'https://www.theverge.com/rss/index.xml',                category: 'tech',          weight: 8 },
  { id: 'science_daily',     name: 'Science Daily',    url: 'https://www.sciencedaily.com/rss/all.xml',              category: 'science',       weight: 8 },
  { id: 'new_scientist',     name: 'New Scientist',    url: 'https://www.newscientist.com/feed/home/',               category: 'science',       weight: 7 },

  // Wire replacements. Reuters shut down feeds.reuters.com and AP shut down
  // feeds.apnews.com — both hostnames stopped resolving, so those five sources
  // had been failing every 5-minute tick. AP still reaches us through the
  // existing feedx_ap mirror; Reuters has no working public feed left, so its
  // weight is redistributed across these. Verified from the droplet with the
  // bot's own user-agent (200 + live items) on 2026-08-31.
  { id: 'nyt_top',          name: 'NYT Top Stories',  url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'politics',  weight: 9 },
  { id: 'wapo_politics',    name: 'WaPo Politics',    url: 'https://feeds.washingtonpost.com/rss/politics',          category: 'politics',  weight: 9 },
  { id: 'cbs_news',         name: 'CBS News',         url: 'https://www.cbsnews.com/latest/rss/main',                category: 'politics',  weight: 8 },
  { id: 'nbc_news',         name: 'NBC News',         url: 'https://feeds.nbcnews.com/nbcnews/public/news',          category: 'politics',  weight: 8 },
  { id: 'npr_news',         name: 'NPR News',         url: 'https://feeds.npr.org/1001/rss.xml',                     category: 'politics',  weight: 8 },
  { id: 'cnbc_top',         name: 'CNBC Top News',    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',  category: 'economics', weight: 9 },
] as const

// Event/alert adapters that an earlier "optimistic only" pass force-disabled.
// Listed by id so we can flip them back ON in DBs that were seeded while they
// were retired (onConflictDoUpdate below only manages weight/category, not
// is_active, so it won't re-enable them on its own).
const REACTIVATE_SOURCE_IDS: string[] = [
  'cisa_kev',
  'nws_severe_alerts',
  'usgs_quakes_sig',
  'openfda_drug_recalls',
  'openfda_device_recalls',
  'openfda_food_recalls',
]

// Sources force-disabled. India/Asia-centric feeds (skewing toward Indian news),
// plus feeds that are dead or unreachable from the box: tmz/ign (403), espn_top
// (returns 202 empty — ESPN's RSS is gone; replaced by CBS/Fox Sports), and
// cointelegraph (fetch-fails from the droplet IP; crypto stays covered by
// CoinDesk/Decrypt/The Block/Blockworks). Rows kept for history; flip back on by
// removing an id here.
const DISABLE_SOURCE_IDS: string[] = [
  // India/Asia-centric (NA/Europe focus).
  'scmp_world', 'toi_top', 'nikkei_asia',
  // Dead or unreachable from the box: tmz/ign (403), espn_top (202 empty —
  // ESPN's RSS is gone, replaced by CBS/Fox Sports), cointelegraph (fetch-fails
  // from the droplet IP; crypto stays covered by CoinDesk/Decrypt/The Block).
  'tmz', 'ign', 'espn_top', 'cointelegraph',
  // Retired 2026-08-31. These were failing 288 of 288 fetches a day, silently,
  // for months — the audit log had 16.9k FETCH_FAILED rows in a week. Reuters
  // and AP both discontinued their public RSS and the hostnames no longer
  // resolve (DNS, not a block, so no user-agent or header fixes this). cbc_top
  // fails the HTTP/2 handshake and axios_markets 403s. Replacements are in
  // DEFAULT_NEWS_SOURCES above; AP is still covered via feedx_ap.
  'reuters_world', 'reuters_politics', 'reuters_business',
  'ap_top', 'ap_politics',
  'cbc_top', 'axios_markets',
]

export async function seedIfEmpty() {
  await syncDefaultSources()
}

export async function syncDefaultSources() {
  // url + name + weight + category are MANAGED here: re-applied on every boot so a
  // rebalance OR a feed-URL fix (e.g. a moved/blocked RSS endpoint) actually
  // reaches a long-running DB. (The previous onConflictDoNothing meant edits to
  // this list never propagated past a fresh install.) is_active stays under
  // operator control — except the retired adapters below, forced off.
  for (const source of DEFAULT_NEWS_SOURCES) {
    db.insert(newsSources)
      .values({ ...source, isActive: 1 })
      .onConflictDoUpdate({
        target: newsSources.id,
        set: { url: source.url, name: source.name, weight: source.weight, category: source.category },
      })
      .run()
  }

  // Force-reactivate the event/alert adapters on DBs where a prior pass disabled
  // them (e.g. the live droplet from the "optimistic only" deploy).
  const reactivated = db.update(newsSources)
    .set({ isActive: 1 })
    .where(inArray(newsSources.id, REACTIVATE_SOURCE_IDS))
    .run()

  // Force-disable the India/Asia-centric feeds (NA/Europe focus).
  const geoDisabled = db.update(newsSources)
    .set({ isActive: 0 })
    .where(inArray(newsSources.id, DISABLE_SOURCE_IDS))
    .run()

  // Settings singleton — threshold stays 6.5 (backtest-supported). Left untouched
  // on existing DBs so operator tuning survives, so editing these only affects a
  // fresh install; change a running deployment from the dashboard or /api/settings.
  //
  // Cadence targets ~30 posts/day, and the COOLDOWN is what delivers it: at 45
  // min between posts the ceiling is 32/day (1440/45). daily_post_limit is only
  // a runaway guard on LLM spend.
  //
  // It must sit ABOVE the cooldown-implied rate. isOverDailyLimit() is a hard
  // stop over a ROLLING 24h window, not a per-calendar-day allowance, so a limit
  // at or below the natural rate binds permanently: generation stops and does
  // not resume until enough posts age out of the window. Setting it to 30 (the
  // target) rather than above 32 (the ceiling) silenced production for hours.
  db.insert(settings)
    .values({
      id: 'singleton',
      platformName: 'SignalDesk',
      marketBaseUrl: 'https://yourplatform.com/markets',
      autoGenerateThreshold: 6.5,
      postCooldownMinutes: 45,
      dailyPostLimit: 60,
      larkEnabled: 1,
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run()

  const sourcesCount = db.select().from(newsSources).all().length
  const settingsCount = db.select().from(settings).all().length

  console.log(`[startup] sources synced (${sourcesCount} news_sources, ${settingsCount} settings row; ${reactivated.changes} event/alert active, ${geoDisabled.changes} geo-disabled)`)
}
