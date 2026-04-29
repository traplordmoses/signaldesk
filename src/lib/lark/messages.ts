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

// ====================== Cards ======================

function buildReviewCard(cluster: EventCluster, posts: GeneratedPost[]): object {
  const elements: object[] = []

  const { names: sourceNames, earliest } = getClusterSources(cluster)
  const categoryLabel = CATEGORY_LABELS[cluster.category] ?? cluster.category
  const timeAgo = formatTimeAgo(cluster.firstSeenAt)
  const absTime = formatAbsTime(earliest)

  let topics: string[] = []
  try { topics = JSON.parse(cluster.topics ?? '[]') } catch { topics = [] }

  // Headline
  elements.push(md(`**${cluster.canonicalHeadline}**`))

  // Time + sources row
  const sourceLine = sourceNames.length > 0 ? sourceNames.join(' · ') : 'Unknown source'
  elements.push(md(`🕐 **${timeAgo}** (${absTime})  ·  📰 ${sourceLine}`))

  // Category + topic tags row
  const allTags = [categoryLabel, ...topics.map(englishTag)]
  elements.push(md(allTags.join('  ·  ') + `  ·  Sources: ${cluster.sourceCount ?? 1}  ·  Score: **${(cluster.relevanceScore ?? 0).toFixed(1)}**/10`))

  // Risk warning
  if (cluster.riskLevel === 'high') {
    elements.push(md('⚠️ **HIGH RISK** — Review carefully before approving'))
  } else if (cluster.riskLevel === 'medium') {
    elements.push(md('⚠️ Medium risk — double check before approving'))
  }

  for (const post of posts) {
    const badge = MODE_BADGES[post.contentMode] ?? post.contentMode
    const isPureNews = post.contentMode === 'pure_news'
    const displayContent = isPureNews
      ? post.content.replace(/https?:\/\/\S+/g, '').replace(/\n+$/, '').trim()
      : post.content

    elements.push({ tag: 'hr' })
    elements.push(md(`**${badge}** ${isPureNews ? '_(no link — tweet only)_' : ''}  ·  Score: ${post.estimatedScore ?? 'N/A'}/10`))

    // Read-only display of the proposed tweet — this is what reviewers read
    // 90% of the time before clicking Approve. Quote-style for readability.
    const quoted = displayContent.split('\n').map(l => `> ${l}`).join('\n')
    elements.push(md(quoted))
    elements.push(md(`_${displayContent.length}/280 chars_`))

    // Primary actions FIRST — most reviews skip the edit step entirely.
    // Putting Approve/Reject before the edit form makes the common path
    // a one-click action instead of looking like the card is asking you
    // to fill in a form.
    elements.push(twoColumnButtons(
      callbackButton({ text: '✅ Approve & Copy', type: 'primary', action: 'approve', postId: post.id }),
      callbackButton({ text: '❌ Reject',          type: 'danger',  action: 'reject',  postId: post.id }),
    ))

    // Secondary inline-edit affordance. Reviewer types in the box and presses
    // Save edit if they want to tweak wording before approving. Submits
    // `form_value.edited_content_<postId>` with the action callback, which
    // route.ts:extractFormString resolves into action.value.editedContent.
    elements.push(md('_Tweak wording? Edit below and press Save, then Approve._'))
    elements.push({
      tag: 'form',
      name: `edit_form_${post.id}`,
      elements: [
        {
          tag: 'input',
          // Lark requires globally-unique input names across the whole card.
          // Scoped per post for safety even on single-post cards.
          name: `edited_content_${post.id}`,
          input_type: 'multiline_text',
          rows: 3,
          default_value: displayContent,
          placeholder: plainText('Edited tweet text'),
        },
        callbackButton({
          text: '💾 Save edit',
          type: 'default',
          action: 'save_edit',
          postId: post.id,
          formSubmit: true,
        }),
      ],
    })
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
          callbackButton({ text: '✅ Approve & Copy', type: 'primary', action: 'approve', postId: post.id }),
          callbackButton({ text: '❌ Reject',          type: 'danger',  action: 'reject',  postId: post.id }),
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
