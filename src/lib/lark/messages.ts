import { larkPost, larkPatch } from './client'
import { db } from '@/lib/db'
import { newsItems } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import type { EventCluster, GeneratedPost } from '@/types'

// Lark Card Schema 2.0 — review cards use inline editable input so reviewers
// can edit a draft directly in the group chat instead of via DM round-trip.
// Schema 2.0 button clicks deliver to the Event Subscription URL (the
// "card.action.trigger" callback subscription, not the legacy v1).

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

function callbackButton(opts: {
  text: string
  type?: 'primary' | 'default' | 'danger'
  action: string
  postId?: string
  formSubmit?: boolean
}) {
  const value: Record<string, string> = { action: opts.action }
  if (opts.postId) value.postId = opts.postId
  const button: Record<string, unknown> = {
    tag: 'button',
    text: plainText(opts.text),
    type: opts.type ?? 'default',
    behaviors: [{ type: 'callback', value }],
  }
  if (opts.formSubmit) button.form_action_type = 'submit'
  return button
}

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

function twoColumnButtons(left: object, right: object) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [right] },
    ],
  }
}

function threeColumnButtons(left: object, middle: object, right: object) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [middle] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [right] },
    ],
  }
}

// ====================== Cards ======================

/**
 * Build the review card.
 *
 * Two render modes per post, controlled by `editingPostId`:
 *   - read-only (default): just the tweet quote and [Approve][Reject][Edit]
 *     buttons. The textbox is hidden — reviewers who want to approve as-is
 *     do it in two clicks (read → approve), no form-filling vibe.
 *   - edit mode (only when post.id === editingPostId): the textbox appears
 *     pre-filled with the current content, plus [Save edit][Cancel] and the
 *     usual [Approve][Reject] buttons. Triggered by clicking Edit; the
 *     handler patches the card to swap in this view.
 *
 * Multi-post clusters (rare under the pure_news lock) render each post
 * independently — only the post that was clicked enters edit mode.
 */
export function buildReviewCard(
  cluster: EventCluster,
  posts: GeneratedPost[],
  opts: { editingPostId?: string } = {},
): object {
  const elements: object[] = []

  const { names: sourceNames, earliest } = getClusterSources(cluster)
  const categoryLabel = CATEGORY_LABELS[cluster.category] ?? cluster.category
  const timeAgo = formatTimeAgo(cluster.firstSeenAt)
  const absTime = formatAbsTime(earliest)

  let topics: string[] = []
  try { topics = JSON.parse(cluster.topics ?? '[]') } catch { topics = [] }

  // ── Header block — condensed metadata. Schema 2.0 doesn't support the
  // `note` element (Lark API error 200861: "cards of schema V2 no longer
  // support this capability; unsupported tag note"). Using markdown rows
  // with italic / bold formatting for the same visual hierarchy.
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
    const isEditing = opts.editingPostId === post.id

    elements.push({ tag: 'hr' })

    // Mode badge + char count on one tight line
    elements.push(md(`**${badge}**  ·  _${displayContent.length}/280 chars_`))

    // Tweet quote — always visible so reviewer can read before deciding
    const quoted = displayContent.split('\n').map(l => `> ${l}`).join('\n')
    elements.push(md(quoted))

    if (isEditing) {
      // ── Edit mode ────────────────────────────────────────────────────
      elements.push(md('_Edit the wording below, then Save (or Cancel to discard)._'))
      elements.push({
        tag: 'form',
        name: `edit_form_${post.id}`,
        elements: [
          {
            tag: 'input',
            name: `edited_content_${post.id}`,
            input_type: 'multiline_text',
            rows: 3,
            default_value: displayContent,
            placeholder: plainText('Edited tweet text'),
          },
          callbackButton({
            text: '💾 Save edit',
            type: 'primary',
            action: 'save_edit',
            postId: post.id,
            formSubmit: true,
          }),
        ],
      })
      elements.push(threeColumnButtons(
        callbackButton({ text: '↩️ Cancel', type: 'default', action: 'cancel_edit', postId: post.id }),
        callbackButton({ text: '✅ Approve', type: 'primary', action: 'approve',    postId: post.id }),
        callbackButton({ text: '❌ Reject',  type: 'danger',  action: 'reject',     postId: post.id }),
      ))
    } else {
      // ── Read-only mode (default) ─────────────────────────────────────
      // 3-column action row: green | gray | red. Visually balanced —
      // Approve is primary, Reject is danger, Edit sits between as a
      // neutral secondary action.
      elements.push(threeColumnButtons(
        callbackButton({ text: '✅ Approve', type: 'primary', action: 'approve',    postId: post.id }),
        callbackButton({ text: '✏️ Edit',    type: 'default', action: 'show_edit',  postId: post.id }),
        callbackButton({ text: '❌ Reject',  type: 'danger',  action: 'reject',     postId: post.id }),
      ))
    }
  }

  // Pause bot at the bottom
  elements.push({ tag: 'hr' })
  elements.push(callbackButton({ text: '⏸ Pause Bot', type: 'default', action: 'pause_bot' }))

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
          ? 'SignalDesk bot is now **paused**. No new posts will be sent to this group until you resume.'
          : 'SignalDesk bot is now **active**. New high-scoring posts will be sent here automatically.'),
        paused
          ? callbackButton({ text: '▶️ Resume Bot', type: 'primary', action: 'resume_bot' })
          : callbackButton({ text: '⏸ Pause Bot', type: 'default', action: 'pause_bot' }),
      ],
    },
  }
}

function buildApprovalCard(post: GeneratedPost): object {
  const intentUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(post.content)
  const displayContent = post.content.split('\n').map(l => `> ${l}`).join('\n')
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: plainText('✅ Post approved — ready to publish'),
      template: 'green',
    },
    body: {
      elements: [
        md(displayContent),
        urlButton({ text: '🐦 Open X to post', url: intentUrl, type: 'primary' }),
      ],
    },
  }
}

function buildUpdatedCard(cluster: EventCluster, post: GeneratedPost, actorName: string, approved: boolean): object {
  const displayContent = post.content.split('\n').map(l => `> ${l}`).join('\n')
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: plainText(cluster.canonicalHeadline),
      template: approved ? 'green' : 'grey',
    },
    body: {
      elements: [
        md(approved ? `✅ **Approved** by ${actorName}` : `❌ **Rejected** by ${actorName}`),
        md(displayContent),
      ],
    },
  }
}

function buildEditedGroupCard(cluster: EventCluster, post: GeneratedPost, actorName: string): object {
  const displayContent = post.content.split('\n').map(l => `> ${l}`).join('\n')
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: plainText(cluster.canonicalHeadline),
      template: 'blue',
    },
    body: {
      elements: [
        md(`✏️ **Edited** by ${actorName}`),
        md(displayContent),
        md(`_${post.content.length}/280 chars_`),
        // After edit, offer Approve / Reject again so the reviewer can publish or kill in one click.
        twoColumnButtons(
          callbackButton({ text: '✅ Approve', type: 'primary', action: 'approve', postId: post.id }),
          callbackButton({ text: '❌ Reject',  type: 'danger',  action: 'reject',  postId: post.id }),
        ),
      ],
    },
  }
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
