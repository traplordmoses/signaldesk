import Parser from 'rss-parser'
import { createHash, randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { newsSources, newsItems, auditLog } from '@/lib/db/schema'
import { eq, gt, and } from 'drizzle-orm'
import { scoreItem, detectRisk } from './scorer'

const parser = new Parser({ timeout: 10000 })
const FETCH_TIMEOUT_MS = 10000
const SUMMARY_LIMIT = 500
const RECENT_SOURCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const SOURCE_USER_AGENT = process.env.SIGNALDESK_USER_AGENT
  ?? `SignalDeskBot/1.0 (${process.env.NEXT_PUBLIC_APP_URL ?? 'local development'})`

const DEFAULT_FETCH_HEADERS = {
  'User-Agent': SOURCE_USER_AGENT,
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*;q=0.8',
}

function sha256(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

// Normalize URL for dedup: lowercase host, drop UTM/tracking params, strip trailing slash,
// strip fragment, strip AMP suffix. Same article via Reuters direct + AMP + Google News
// redirect now hashes to the same value.
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref|ref_|igshid|s_cid|share)/i
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    u.host = u.host.toLowerCase()
    const keep = new URLSearchParams()
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.append(k, v)
    }
    u.search = keep.toString() ? `?${keep.toString()}` : ''
    let path = u.pathname.replace(/\/+$/, '')                  // trailing slash
    path = path.replace(/\/(amp|amp\.html|amp\.htm)$/i, '')    // AMP suffix
    u.pathname = path || '/'
    return u.toString()
  } catch {
    return raw
  }
}

// Title-hash key: lowercase, strip newsy prefixes (BREAKING:, JUST IN:, EXCLUSIVE:),
// strip non-alphanumerics, take first 12 tokens. "BREAKING: Fed Holds Rates Steady"
// and "Fed Holds Rates Steady After Powell Remarks" now collide; ditto reordered/punctuation variants.
const TITLE_PREFIXES = /^(breaking|just in|exclusive|update|live|developing|alert|watch)\s*:/i
function titleWords(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(TITLE_PREFIXES, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.split(' ').slice(0, 12).join(' ')
}

interface NormalizedItem {
  id: string
  title: string
  summary: string
  url: string
  urlHash: string
  titleHash: string
  sourceId: string
  sourceName: string
  category: string
  publishedAt: number
}

type SourceRecord = typeof newsSources.$inferSelect

interface RssEntry {
  title?: string
  link?: string
  guid?: string
  contentSnippet?: string
  summary?: string
  content?: string
  pubDate?: string
  isoDate?: string
  updated?: string
}

interface CisaKevResponse {
  vulnerabilities?: Array<{
    cveID?: string
    vendorProject?: string
    product?: string
    vulnerabilityName?: string
    dateAdded?: string
    shortDescription?: string
    requiredAction?: string
    knownRansomwareCampaignUse?: string
    notes?: string
  }>
}

interface UsgsSignificantQuakesResponse {
  features?: Array<{
    properties?: {
      title?: string
      place?: string
      mag?: number
      time?: number
      url?: string
    }
  }>
}

interface NwsActiveAlertsResponse {
  features?: Array<{
    id?: string
    properties?: {
      id?: string
      uri?: string
      event?: string
      headline?: string
      description?: string
      instruction?: string
      areaDesc?: string
      severity?: string
      urgency?: string
      certainty?: string
      sent?: string
      effective?: string
    }
  }>
}

interface OpenFdaEnforcementResponse {
  results?: Array<{
    event_id?: string
    classification?: string
    product_description?: string
    reason_for_recall?: string
    recalling_firm?: string
    report_date?: string
    recall_initiation_date?: string
    status?: string
    distribution_pattern?: string
    country?: string
  }>
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/&lt;br\s*\/?&gt;/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTimestamp(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now()
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function parseFdaDate(value: string | null | undefined): number {
  if (!value) return Date.now()
  if (/^\d{8}$/.test(value)) {
    const yyyy = value.slice(0, 4)
    const mm = value.slice(4, 6)
    const dd = value.slice(6, 8)
    return parseTimestamp(`${yyyy}-${mm}-${dd}T00:00:00Z`)
  }
  return parseTimestamp(value)
}

function absoluteUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString()
  } catch {
    return raw
  }
}

async function fetchWithTimeout(url: string, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: { ...DEFAULT_FETCH_HEADERS, ...headers },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return response
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const response = await fetchWithTimeout(url, headers)
  return response.text()
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetchWithTimeout(url, { 'Accept': 'application/json, */*;q=0.8', ...headers })
  return response.json() as Promise<T>
}

function toNormalizedItem(
  source: SourceRecord,
  input: { title: string; summary?: string; url: string; publishedAt?: number }
): NormalizedItem | null {
  const title = cleanText(input.title)
  const url = input.url.trim()
  if (!title || !url) return null

  const normalizedUrl = normalizeUrl(url)
  return {
    id: randomUUID(),
    title,
    summary: cleanText(input.summary ?? '').slice(0, SUMMARY_LIMIT),
    url: normalizedUrl,
    urlHash: sha256(normalizedUrl),
    titleHash: sha256(titleWords(title)),
    sourceId: source.id,
    sourceName: source.name,
    category: source.category,
    publishedAt: input.publishedAt ?? Date.now(),
  }
}

async function fetchRssSource(source: SourceRecord): Promise<NormalizedItem[]> {
  const xml = await fetchText(source.url)
  const feed = await parser.parseString(xml)
  const items: NormalizedItem[] = []

  for (const entry of (feed.items ?? []) as RssEntry[]) {
    const rawUrl = entry.link ?? entry.guid ?? ''
    if (!rawUrl) continue

    const item = toNormalizedItem(source, {
      title: entry.title ?? '',
      summary: entry.contentSnippet ?? entry.summary ?? entry.content ?? '',
      url: absoluteUrl(rawUrl, source.url),
      publishedAt: parseTimestamp(entry.isoDate ?? entry.pubDate ?? entry.updated),
    })
    if (item) items.push(item)
  }

  return items
}

async function fetchSecCurrent(source: SourceRecord, sourceUrl: URL): Promise<NormalizedItem[]> {
  const filingType = sourceUrl.searchParams.get('type') ?? '8-K'
  const count = sourceUrl.searchParams.get('count') ?? '100'
  const secUrl = new URL('https://www.sec.gov/cgi-bin/browse-edgar')
  secUrl.searchParams.set('action', 'getcurrent')
  secUrl.searchParams.set('type', filingType)
  secUrl.searchParams.set('owner', 'include')
  secUrl.searchParams.set('count', count)
  secUrl.searchParams.set('output', 'atom')

  const xml = await fetchText(secUrl.toString(), { 'Accept': 'application/atom+xml, application/xml, text/xml' })
  const feed = await parser.parseString(xml)
  const items: NormalizedItem[] = []

  for (const entry of (feed.items ?? []) as RssEntry[]) {
    const rawUrl = entry.link ?? entry.guid ?? ''
    if (!rawUrl) continue

    const item = toNormalizedItem(source, {
      title: entry.title ?? `${filingType} filing`,
      summary: entry.contentSnippet ?? entry.summary ?? entry.content ?? '',
      url: absoluteUrl(rawUrl, 'https://www.sec.gov/'),
      publishedAt: parseTimestamp(entry.isoDate ?? entry.pubDate ?? entry.updated),
    })
    if (item) items.push(item)
  }

  return items
}

async function fetchCisaKev(source: SourceRecord): Promise<NormalizedItem[]> {
  try {
    const data = await fetchJson<CisaKevResponse>('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json')
    return cisaKevItemsFromJson(source, data)
  } catch {
    return fetchCisaKevFromCatalogPage(source)
  }
}

function cisaKevItemsFromJson(source: SourceRecord, data: CisaKevResponse): NormalizedItem[] {
  const cutoff = Date.now() - RECENT_SOURCE_WINDOW_MS
  const items: NormalizedItem[] = []

  for (const vuln of data.vulnerabilities ?? []) {
    const cve = vuln.cveID ?? ''
    const publishedAt = parseTimestamp(vuln.dateAdded)
    if (!cve || publishedAt < cutoff) continue

    const vendorProduct = [vuln.vendorProject, vuln.product].filter(Boolean).join(' ')
    const title = `CISA adds ${vendorProduct || cve} vulnerability to KEV catalog`
    const summaryParts = [
      vuln.vulnerabilityName,
      vuln.shortDescription,
      vuln.requiredAction ? `Required action: ${vuln.requiredAction}` : '',
      vuln.knownRansomwareCampaignUse ? `Ransomware use: ${vuln.knownRansomwareCampaignUse}` : '',
    ].filter(Boolean)

    const item = toNormalizedItem(source, {
      title,
      summary: summaryParts.join(' '),
      url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(cve)}`,
      publishedAt,
    })
    if (item) items.push(item)
  }

  return items
}

async function fetchCisaKevFromCatalogPage(source: SourceRecord): Promise<NormalizedItem[]> {
  const html = await fetchText('https://www.cisa.gov/known-exploited-vulnerabilities-catalog', {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  })
  const text = cleanText(html)
  const cutoff = Date.now() - RECENT_SOURCE_WINDOW_MS
  const items: NormalizedItem[] = []
  const blocks = text.match(/CVE-\d{4}-\d{4,}[\s\S]*?(?=CVE-\d{4}-\d{4,}|$)/g) ?? []

  for (const block of blocks) {
    const cve = block.match(/CVE-\d{4}-\d{4,}/)?.[0]
    const dateAdded = block.match(/Date Added:\s*(\d{4}-\d{2}-\d{2})/)?.[1]
    if (!cve || !dateAdded) continue

    const publishedAt = parseTimestamp(dateAdded)
    if (publishedAt < cutoff) continue

    const summary = truncate(
      block
        .replace(cve, '')
        .replace(/Related CWEs?:[\s\S]*$/i, '')
        .replace(/Known To Be Used in Ransomware Campaigns\?.*$/i, '')
        .trim(),
      450
    )

    const item = toNormalizedItem(source, {
      title: `CISA adds ${cve} vulnerability to KEV catalog`,
      summary,
      url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(cve)}`,
      publishedAt,
    })
    if (item) items.push(item)
  }

  return items
}

async function fetchUsgsSignificantQuakes(source: SourceRecord): Promise<NormalizedItem[]> {
  const data = await fetchJson<UsgsSignificantQuakesResponse>('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson')
  const items: NormalizedItem[] = []

  for (const feature of data.features ?? []) {
    const props = feature.properties
    if (!props?.title || !props.url) continue

    const item = toNormalizedItem(source, {
      title: props.title,
      summary: `Magnitude ${props.mag ?? 'unknown'} earthquake near ${props.place ?? 'unknown location'}.`,
      url: props.url,
      publishedAt: parseTimestamp(props.time),
    })
    if (item) items.push(item)
  }

  return items
}

async function fetchNwsSevereAlerts(source: SourceRecord): Promise<NormalizedItem[]> {
  const data = await fetchJson<NwsActiveAlertsResponse>('https://api.weather.gov/alerts/active?status=actual&message_type=alert')
  const items: NormalizedItem[] = []
  const severe = new Set(['Extreme', 'Severe'])

  for (const feature of data.features ?? []) {
    const props = feature.properties
    if (!props || !severe.has(props.severity ?? '')) continue

    const title = props.headline ?? [props.event, props.areaDesc].filter(Boolean).join(' - ')
    const url = props.uri ?? props.id ?? feature.id ?? ''
    if (!title || !url) continue

    const item = toNormalizedItem(source, {
      title,
      summary: [props.description, props.instruction].filter(Boolean).join(' '),
      url,
      publishedAt: parseTimestamp(props.sent ?? props.effective),
    })
    if (item) items.push(item)
  }

  return items
}

function openFdaKindLabel(kind: string): string {
  if (kind === 'device') return 'medical device'
  return kind
}

async function fetchOpenFdaEnforcement(source: SourceRecord, sourceUrl: URL): Promise<NormalizedItem[]> {
  const kind = sourceUrl.searchParams.get('kind') ?? 'drug'
  if (!['drug', 'device', 'food'].includes(kind)) {
    throw new Error(`Unsupported openFDA enforcement kind: ${kind}`)
  }

  const apiKey = process.env.OPENFDA_API_KEY
  const apiUrl = `https://api.fda.gov/${kind}/enforcement.json?sort=report_date:desc&limit=50${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`
  const data = await fetchJson<OpenFdaEnforcementResponse>(apiUrl)
  const cutoff = Date.now() - RECENT_SOURCE_WINDOW_MS
  const items: NormalizedItem[] = []
  const kindLabel = openFdaKindLabel(kind)

  for (const recall of data.results ?? []) {
    const eventId = recall.event_id
    const publishedAt = parseFdaDate(recall.report_date ?? recall.recall_initiation_date)
    if (!eventId || publishedAt < cutoff) continue
    if (!['Class I', 'Class II'].includes(recall.classification ?? '')) continue

    const product = truncate(cleanText(recall.product_description ?? `${kindLabel} product`), 130)
    const title = `FDA ${kindLabel} recall: ${product}`
    const summaryParts = [
      recall.classification,
      recall.recalling_firm ? `Firm: ${recall.recalling_firm}` : '',
      recall.reason_for_recall ? `Reason: ${recall.reason_for_recall}` : '',
      recall.distribution_pattern ? `Distribution: ${recall.distribution_pattern}` : '',
    ].filter(Boolean)

    const item = toNormalizedItem(source, {
      title,
      summary: summaryParts.join(' '),
      url: `https://api.fda.gov/${kind}/enforcement.json?search=event_id:${encodeURIComponent(eventId)}&limit=1`,
      publishedAt,
    })
    if (item) items.push(item)
  }

  return items
}

async function fetchSignaldeskSource(source: SourceRecord): Promise<NormalizedItem[]> {
  const sourceUrl = new URL(source.url)
  const route = `${sourceUrl.hostname}${sourceUrl.pathname}`

  switch (route) {
    case 'sec/current':
      return fetchSecCurrent(source, sourceUrl)
    case 'cisa/kev':
      return fetchCisaKev(source)
    case 'nws/severe-alerts':
      return fetchNwsSevereAlerts(source)
    case 'usgs/significant-quakes':
      return fetchUsgsSignificantQuakes(source)
    case 'openfda/enforcement':
      return fetchOpenFdaEnforcement(source, sourceUrl)
    default:
      throw new Error(`Unsupported internal source adapter: ${route}`)
  }
}

async function fetchSource(source: typeof newsSources.$inferSelect): Promise<{ items: NormalizedItem[]; error?: string }> {
  try {
    const items = source.url.startsWith('signaldesk://')
      ? await fetchSignaldeskSource(source)
      : await fetchRssSource(source)

    return { items }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { items: [], error }
  }
}

export async function fetchAllSources(): Promise<{ ingested: number; errors: number }> {
  const sources = db.select().from(newsSources).where(eq(newsSources.isActive, 1)).all()

  let ingested = 0
  let errors = 0

  const results = await Promise.allSettled(sources.map(s => fetchSource(s)))

  for (let i = 0; i < results.length; i++) {
    const source = sources[i]
    const result = results[i]

    if (result.status === 'rejected' || result.value.error) {
      errors++
      const errMsg = result.status === 'rejected' ? String(result.reason) : result.value.error!
      // Update source error
      db.update(newsSources)
        .set({ lastError: errMsg, lastFetchedAt: Date.now() })
        .where(eq(newsSources.id, source.id))
        .run()

      try {
        db.insert(auditLog).values({
          id: randomUUID(),
          eventType: 'error',
          entityType: 'news_source',
          entityId: source.id,
          errorCode: 'FETCH_FAILED',
          errorMessage: errMsg,
          details: JSON.stringify({ sourceUrl: source.url }),
          createdAt: Date.now(),
        }).run()
      } catch (e) {
        console.error(`audit log write failed (news_source ${source.id}):`, e)
      }
      continue
    }

    const { items } = result.value
    const weight = source.weight ?? 5
    // Dedup window for title-hash bumped from 4h → 24h. RSS feeds often re-publish
    // the same article hours later with a slightly mutated URL (rotating tracking
    // params, AMP variants my normalizer doesn't catch, etc.). 4h was too narrow
    // — the same Trump-approval story re-clustered every 4-5h and produced a fresh
    // event_cluster, which the cron then re-sent to Lark.
    const titleDedupCutoff = Date.now() - 24 * 60 * 60 * 1000

    for (const item of items) {
      try {
        // Check url_hash dedup
        const existing = db.select({ id: newsItems.id })
          .from(newsItems)
          .where(eq(newsItems.urlHash, item.urlHash))
          .get()
        if (existing) continue

        // Check title_hash near-dedup (last 24 hours)
        const recentTitle = db.select({ id: newsItems.id })
          .from(newsItems)
          .where(
            and(
              eq(newsItems.titleHash, item.titleHash),
              gt(newsItems.ingestedAt, titleDedupCutoff)
            )
          )
          .get()
        if (recentTitle) continue

        const score = scoreItem(item.title, item.summary ?? '', weight, item.publishedAt)
        const risk = detectRisk(item.title + ' ' + (item.summary ?? ''))

        db.insert(newsItems).values({
          ...item,
          ingestedAt: Date.now(),
          relevanceScore: score,
          riskLevel: risk.level,
          riskReasons: JSON.stringify(risk.reasons),
          isProcessed: 0,
        }).run()

        ingested++
      } catch (e) {
        console.error(`news_item insert failed (url=${item.url.slice(0, 80)}):`, e)
      }
    }

    // Update last fetched
    db.update(newsSources)
      .set({ lastFetchedAt: Date.now(), lastError: null })
      .where(eq(newsSources.id, source.id))
      .run()
  }

  try {
    db.insert(auditLog).values({
      id: randomUUID(),
      eventType: 'news_ingested',
      details: JSON.stringify({ ingested, errors }),
      createdAt: Date.now(),
    }).run()
  } catch (e) {
    console.error('audit log write failed (news_ingested):', e)
  }

  return { ingested, errors }
}
