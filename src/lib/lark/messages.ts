import { larkPost } from './client'
import { db } from '@/lib/db'
import { newsItems } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import type { EventCluster, GeneratedPost } from '@/types'

// Lark Card Schema 2.0 — LINK MODE.
//
// Review cards are display-only plus one "Post on X" link button per draft.
// The button is a pure `open_url` link into X's intent composer; it does NOT
// fire a `card.action.trigger` callback, so the bot needs no inbound webhook /
// Card Request URL. Lark's long connection carries events, not card callbacks,
// and SignalDesk's Lark surface is now fully outbound. Rich management
// (approve/reject/edit/history) lives in the dashboard, not the card.

const MODE_BADGES: Record<string, string> = {
  pure_news:  '⚡ Breaking',
  news_odds:  '📊 News + Odds',
  engagement: '💬 Engagement',
}

const CATEGORY_LABELS: Record<string, string> = {
  politics:  '🗳 Politics',
  economics: '📈 Economics',
  crypto:    '₿ Crypto',
  sports:    '🏆 Sports',
  tech:      '💻 Tech',
  culture:   '🎭 Culture',
  cyber:     '🛡 Cyber',
  health:    '🏥 Health',
  weather:   '🌪 Weather',
}

const TAG_LABELS: Record<string, string> = {
  '🇺🇸 美国': '🇺🇸 United States',
  '🇨🇳 中国': '🇨🇳 China',
  '🇷🇺 俄罗斯': '🇷🇺 Russia',
  '🇺🇦 乌克兰': '🇺🇦 Ukraine',
  '🇮🇷 伊朗': '🇮🇷 Iran',
  '🇮🇱 以色列': '🇮🇱 Israel',
  '🇪🇺 欧盟': '🇪🇺 European Union',
  '🇬🇧 英国': '🇬🇧 United Kingdom',
  '🌏 中东': '🌏 Middle East',
  '🇩🇪 德国': '🇩🇪 Germany',
  '🇯🇵 日本': '🇯🇵 Japan',
  '🇰🇷 韩国': '🇰🇷 South Korea',
  '🗳 选举': '🗳 Elections',
  '💰 利率/央行': '💰 Rates/Central Banks',
  '💥 军事/冲突': '💥 Military/Conflict',
  '⚖️ 制裁/法律': '⚖️ Sanctions/Legal',
  '🪙 加密': '🪙 Crypto',
  '📊 宏观经济': '📊 Macro',
  '🛢 能源': '🛢 Energy',
  '🎵 娱乐': '🎵 Entertainment',
  '🏆 体育': '🏆 Sports',
  '🏥 健康/医疗': '🏥 Health/Medical',
  '🌍 气候': '🌍 Climate',
  '🛡 Cybersecurity': '🛡 Cybersecurity',
  '🌪 Severe Weather': '🌪 Severe Weather',
}

function englishTag(tag: string): string {
  return TAG_LABELS[tag] ?? tag
}

function headerTemplate(riskLevel: string): string {
  if (riskLevel === 'high') return 'red'
  if (riskLevel === 'medium') return 'orange'
  return 'green'
}

function formatTimeAgo(ts: number): string {
  const diffMin = Math.floor((Date.now() - ts) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}min ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return `${Math.floor(diffH / 24)}d ago`
}

function formatAbsTime(ts: number): string {
  const d = new Date(ts)
  const month = d.toLocaleString('en', { month: 'short' })
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${month} ${day} ${hh}:${mm}`
}

function getClusterSources(cluster: EventCluster): { names: string[]; earliest: number } {
  try {
    const ids: string[] = JSON.parse(cluster.constituentItemIds ?? '[]')
    if (ids.length === 0) return { names: [], earliest: cluster.firstSeenAt }
    const items = db.select({ sourceName: newsItems.sourceName, publishedAt: newsItems.publishedAt })
      .from(newsItems)
      .where(inArray(newsItems.id, ids.slice(0, 10)))
      .all()
    const names = [...new Set(items.map(i => i.sourceName))].slice(0, 3)
    const earliest = items.reduce((min, i) => Math.min(min, i.publishedAt), Date.now())
    return { names, earliest }
  } catch (e) {
    console.error(`getClusterSources failed (cluster=${cluster.id}):`, e)
    return { names: [], earliest: cluster.firstSeenAt }
  }
}

// ====================== Schema 2.0 helpers ======================

function md(content: string) {
  return { tag: 'markdown', content }
}

function plainText(content: string) {
  return { tag: 'plain_text', content }
}

/**
 * A pure-navigation button (`open_url`) — opens the URL in the reviewer's
 * browser/app. It does NOT fire a `card.action.trigger` callback, so it needs
 * no inbound endpoint. This is the only button type the card uses now.
 */
function urlButton(opts: { text: string; url: string; type?: 'primary' | 'default' }) {
  return {
    tag: 'button',
    text: plainText(opts.text),
    type: opts.type ?? 'primary',
    behaviors: [{
      type: 'open_url',
      default_url: opts.url,
      pc_url: opts.url,
      ios_url: opts.url,
      android_url: opts.url,
    }],
  }
}

/** X intent URL that pre-fills the composer with the tweet text. */
export function buildXIntentUrl(text: string): string {
  return 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text)
}

// ====================== Cards ======================

/**
 * Build the review card (link mode).
 *
 * Layout:
 *   - cluster headline + metadata + risk
 *   - per draft: mode badge + char count, the tweet quote, and a single
 *     "🐦 Post on X" link button (open_url → X intent composer, pre-filled)
 *
 * No Approve/Reject/Edit/Pause buttons — those were callbacks that needed an
 * inbound endpoint. The reviewer reads a draft and clicks "Post on X" to open
 * it pre-filled (the click is the approval); final wording tweaks happen in the
 * X composer. To skip a draft, ignore it. Approve/reject/edit/history still
 * live in the dashboard for anyone who wants the full surface.
 */
export function buildReviewCard(cluster: EventCluster, posts: GeneratedPost[]): object {
  const elements: object[] = []

  const { names: sourceNames, earliest } = getClusterSources(cluster)
  const categoryLabel = CATEGORY_LABELS[cluster.category] ?? cluster.category
  const timeAgo = formatTimeAgo(cluster.firstSeenAt)
  const absTime = formatAbsTime(earliest)

  let topics: string[] = []
  try { topics = JSON.parse(cluster.topics ?? '[]') } catch { topics = [] }

  elements.push(md(`**${cluster.canonicalHeadline}**`))

  const sourceLine = sourceNames.length > 0 ? sourceNames.join(' · ') : 'Unknown source'
  elements.push(md(`🕐 **${timeAgo}** (${absTime})  ·  📰 ${sourceLine}`))

  const allTags = [categoryLabel, ...topics.map(englishTag)]
  elements.push(md(`${allTags.join('  ·  ')}  ·  Score **${(cluster.relevanceScore ?? 0).toFixed(1)}**/10`))

  if (cluster.riskLevel === 'high') {
    elements.push(md('🚨 **HIGH RISK** — read carefully before posting'))
  } else if (cluster.riskLevel === 'medium') {
    elements.push(md('⚠️ Medium risk — double-check before posting'))
  }

  for (const post of posts) {
    const badge = MODE_BADGES[post.contentMode] ?? post.contentMode
    // What the reviewer sees IS what posts — the quote and the X intent link
    // use the same string, so there are no surprises at post time.
    const content = post.content.trim()

    elements.push({ tag: 'hr' })
    elements.push(md(`**${badge}**  ·  _${content.length}/280 chars_`))

    const quoted = content.split('\n').map(l => `> ${l}`).join('\n')
    elements.push(md(quoted))

    elements.push(urlButton({ text: '🐦 Post on X', url: buildXIntentUrl(content), type: 'primary' }))
  }

  elements.push({ tag: 'hr' })
  elements.push(md(
    '_Tap **Post on X** to open the composer pre-filled — edit the wording there ' +
    'if needed, then post. Ignore a draft to skip it. Full approve/reject/edit ' +
    'history lives in the dashboard._'
  ))

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: plainText('📰 New posts ready for review'),
      template: headerTemplate(cluster.riskLevel ?? 'low'),
    },
    body: { elements },
  }
}

/**
 * Bot status card — posted to the review group when the bot is paused or
 * resumed (via the dashboard or the `npm run pause` / `resume` host CLI).
 * Display-only; there is no Pause/Resume button (that needed a callback).
 */
export function buildBotStatusCard(paused: boolean): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: plainText(paused ? '⏸ Bot Paused' : '▶️ Bot Resumed'),
      template: paused ? 'grey' : 'green',
    },
    body: {
      elements: [
        md(paused
          ? 'SignalDesk bot is now **paused**. No new posts will be sent to this group until it is resumed (dashboard, or `npm run resume` on the host).'
          : 'SignalDesk bot is now **active**. New high-scoring posts will be sent here automatically.'),
      ],
    },
  }
}

// ====================== Send ======================

export async function sendClusterToLark(cluster: EventCluster, posts: GeneratedPost[]): Promise<string | null> {
  const chatId = process.env.LARK_REVIEW_CHAT_ID
  if (!chatId) throw new Error('LARK_REVIEW_CHAT_ID not set')

  const card = buildReviewCard(cluster, posts)
  const result = await larkPost('/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
  return (result.data as { message_id?: string } | undefined)?.message_id ?? null
}

export async function sendBotStatusToGroup(paused: boolean): Promise<void> {
  const chatId = process.env.LARK_REVIEW_CHAT_ID
  if (!chatId) return
  const card = buildBotStatusCard(paused)
  await larkPost('/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}
