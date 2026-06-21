import { larkPost, larkPatch } from './client'
import { db } from '@/lib/db'
import { newsItems } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import type { EventCluster, GeneratedPost } from '@/types'

// Lark Card Schema 1.0 ("v1"). Schema 2.0 cards fall back to an "upgrade your
// app" placeholder on older mobile Lark/Feishu builds — even text-only bodies —
// which is why review/updated cards weren't loading on some phones. v1 renders
// on every client. Button clicks still arrive at /api/lark/callback as a
// card.action.trigger with `action.value` = the button's `value` object, so the
// callback handler (route.ts / handler.ts) is unchanged.

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

// ====================== Card helpers (Schema 1.0) ======================

function md(content: string) {
  return { tag: 'div', text: { tag: 'lark_md', content } }
}

function plainText(content: string) {
  return { tag: 'plain_text', content }
}

function callbackButton(opts: {
  text: string
  type?: 'primary' | 'default' | 'danger'
  action: string
  postId?: string
}) {
  const value: Record<string, string> = { action: opts.action }
  if (opts.postId) value.postId = opts.postId
  return {
    tag: 'button',
    text: plainText(opts.text),
    type: opts.type ?? 'default',
    value,
  }
}

function urlButton(opts: { text: string; url: string; type?: 'primary' | 'default' }) {
  return {
    tag: 'button',
    text: plainText(opts.text),
    type: opts.type ?? 'primary',
    url: opts.url,
  }
}

// Buttons in a row. v1 renders an `action` element's buttons side by side and
// wraps them on narrow screens — no `column_set` (itself a Schema 2.0 element
// that breaks on the same old clients). A lone button must also live in an
// `action`, so every button goes through here.
function buttonRow(...buttons: object[]) {
  return { tag: 'action', actions: buttons }
}

// Wrap a v1 card. No `schema` field, elements live at the top level (not under
// `body`) — that's what makes it v1.
function card(opts: { title: string; template: string; elements: object[] }): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: plainText(opts.title),
      template: opts.template,
    },
    elements: opts.elements,
  }
}

// ====================== Cards ======================

/**
 * Build the review card.
 *
 * Layout (intentionally minimal):
 *   - cluster headline + metadata
 *   - tweet quote
 *   - [Approve]  [Reject]
 *
 * No inline-edit affordance — final wording tweaks happen in the X
 * composer at the manual post step (which is the existing flow after
 * Approve → DM with intent link → human clicks Post on X). That step
 * is itself an edit surface, so duplicating it inside Lark added
 * complexity for a case that's already covered downstream.
 *
 * The `editingPostId` parameter is retained for the function signature
 * back-compat with handler.ts callers but is now unused — all posts
 * render the same minimal card shape.
 */
export function buildReviewCard(
  cluster: EventCluster,
  posts: GeneratedPost[],
  _opts: { editingPostId?: string } = {},
): object {
  const elements: object[] = []

  const { names: sourceNames, earliest } = getClusterSources(cluster)
  const categoryLabel = CATEGORY_LABELS[cluster.category] ?? cluster.category
  const timeAgo = formatTimeAgo(cluster.firstSeenAt)
  const absTime = formatAbsTime(earliest)

  let topics: string[] = []
  try { topics = JSON.parse(cluster.topics ?? '[]') } catch { topics = [] }

  // ── Header block — condensed metadata as markdown rows (bold / italic) for
  // visual hierarchy.
  elements.push(md(`**${cluster.canonicalHeadline}**`))

  const sourceLine = sourceNames.length > 0 ? sourceNames.join(' · ') : 'Unknown source'
  elements.push(md(`🕐 **${timeAgo}** (${absTime})  ·  📰 ${sourceLine}`))

  const allTags = [categoryLabel, ...topics.map(englishTag)]
  elements.push(md(`${allTags.join('  ·  ')}  ·  Score **${(cluster.relevanceScore ?? 0).toFixed(1)}**/10`))

  // Risk warning — only when actually elevated
  if (cluster.riskLevel === 'high') {
    elements.push(md('🚨 **HIGH RISK** — review carefully before approving'))
  } else if (cluster.riskLevel === 'medium') {
    elements.push(md('⚠️ Medium risk — double-check before approving'))
  }

  for (const post of posts) {
    const badge = MODE_BADGES[post.contentMode] ?? post.contentMode
    const isPureNews = post.contentMode === 'pure_news'
    const displayContent = isPureNews
      ? post.content.replace(/https?:\/\/\S+/g, '').replace(/\n+$/, '').trim()
      : post.content

    elements.push({ tag: 'hr' })

    // Mode badge + char count on one tight line
    elements.push(md(`**${badge}**  ·  _${displayContent.length}/280 chars_`))

    // Tweet body — always visible so reviewer can read before deciding
    elements.push(md(displayContent))

    // Two actions, side by side. The X composer at the manual post step
    // is the edit surface for any wording tweaks.
    elements.push(buttonRow(
      callbackButton({ text: '✅ Approve', type: 'primary', action: 'approve', postId: post.id }),
      callbackButton({ text: '❌ Reject',  type: 'danger',  action: 'reject',  postId: post.id }),
    ))
  }

  // Pause bot at the bottom
  elements.push({ tag: 'hr' })
  elements.push(buttonRow(callbackButton({ text: '⏸ Pause Bot', type: 'default', action: 'pause_bot' })))

  return card({
    title: '📰 New posts ready for review',
    template: headerTemplate(cluster.riskLevel ?? 'low'),
    elements,
  })
}

export function buildBotStatusCard(paused: boolean): object {
  return card({
    title: paused ? '⏸ Bot Paused' : '▶️ Bot Resumed',
    template: paused ? 'grey' : 'green',
    elements: [
      md(paused
        ? 'SignalDesk bot is now **paused**. No new posts will be sent to this group until you resume.'
        : 'SignalDesk bot is now **active**. New high-scoring posts will be sent here automatically.'),
      buttonRow(paused
        ? callbackButton({ text: '▶️ Resume Bot', type: 'primary', action: 'resume_bot' })
        : callbackButton({ text: '⏸ Pause Bot', type: 'default', action: 'pause_bot' })),
    ],
  })
}

function buildApprovalCard(post: GeneratedPost): object {
  const intentUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(post.content)
  const displayContent = post.content
  return card({
    title: '✅ Post approved — ready to publish',
    template: 'green',
    elements: [
      md(displayContent),
      buttonRow(urlButton({ text: '🐦 Open X to post', url: intentUrl, type: 'primary' })),
    ],
  })
}

function buildUpdatedCard(cluster: EventCluster, post: GeneratedPost, actorName: string, approved: boolean): object {
  const displayContent = post.content
  return card({
    title: cluster.canonicalHeadline,
    template: approved ? 'green' : 'grey',
    elements: [
      md(approved ? `✅ **Approved** by ${actorName}` : `❌ **Rejected** by ${actorName}`),
      md(displayContent),
    ],
  })
}

function buildEditedGroupCard(cluster: EventCluster, post: GeneratedPost, actorName: string): object {
  const displayContent = post.content
  return card({
    title: cluster.canonicalHeadline,
    template: 'blue',
    elements: [
      md(`✏️ **Edited** by ${actorName}`),
      md(displayContent),
      md(`_${post.content.length}/280 chars_`),
      // After edit, offer Approve / Reject again so the reviewer can publish or kill in one click.
      buttonRow(
        callbackButton({ text: '✅ Approve', type: 'primary', action: 'approve', postId: post.id }),
        callbackButton({ text: '❌ Reject',  type: 'danger',  action: 'reject',  postId: post.id }),
      ),
    ],
  })
}

// ====================== Send / Update ======================

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

export async function updateGroupCard(
  messageId: string,
  cluster: EventCluster,
  post: GeneratedPost,
  actorName: string,
  approved: boolean,
): Promise<void> {
  const card = buildUpdatedCard(cluster, post, actorName, approved)
  await larkPatch(`/im/v1/messages/${messageId}`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}

export async function updateGroupCardEdited(
  messageId: string,
  cluster: EventCluster,
  post: GeneratedPost,
  actorName: string,
): Promise<void> {
  const card = buildEditedGroupCard(cluster, post, actorName)
  await larkPatch(`/im/v1/messages/${messageId}`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}

/**
 * Patch the review card to switch a post into edit mode (textbox visible) or
 * back to read-only mode. Used by the show_edit and cancel_edit callbacks.
 * Pass `editingPostId: undefined` to render the read-only version.
 */
export async function updateReviewCardMode(
  messageId: string,
  cluster: EventCluster,
  posts: GeneratedPost[],
  editingPostId?: string,
): Promise<void> {
  const card = buildReviewCard(cluster, posts, { editingPostId })
  await larkPatch(`/im/v1/messages/${messageId}`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}

export async function sendApprovalDM(openId: string, post: GeneratedPost): Promise<void> {
  const card = buildApprovalCard(post)
  await larkPost('/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}

// Fallback for when sendApprovalDM fails (typically: reviewer has never opened
// a chat with the bot, so Lark refuses receive_id_type=open_id). Posts the same
// approval card as a threaded reply on the original review card so the action
// stays visible right next to the cluster the reviewer just approved.
export async function sendApprovalThreadReply(parentMessageId: string, post: GeneratedPost): Promise<void> {
  const card = buildApprovalCard(post)
  await larkPost(`/im/v1/messages/${parentMessageId}/reply`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
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
