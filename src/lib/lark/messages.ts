import { larkPost, larkPatch } from './client'
import { db } from '@/lib/db'
import { newsItems } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import type { EventCluster, GeneratedPost } from '@/types'

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

// Uses Lark Card Schema 1.0 — elements at root level, supports "action" tag with buttons
function buildReviewCard(cluster: EventCluster, posts: GeneratedPost[]): object {
  const elements: object[] = []

  const { names: sourceNames, earliest } = getClusterSources(cluster)
  const categoryLabel = CATEGORY_LABELS[cluster.category] ?? cluster.category
  const timeAgo = formatTimeAgo(cluster.firstSeenAt)
  const absTime = formatAbsTime(earliest)

  let topics: string[] = []
  try { topics = JSON.parse(cluster.topics ?? '[]') } catch { topics = [] }

  // Headline
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${cluster.canonicalHeadline}**` },
  })

  // Time + sources row
  const sourceLine = sourceNames.length > 0 ? sourceNames.join(' · ') : 'Unknown source'
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `🕐 **${timeAgo}** (${absTime})  ·  📰 ${sourceLine}`,
    },
  })

  // Category + topic tags row
  const allTags = [categoryLabel, ...topics]
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: allTags.join('  ·  ') + `  ·  Sources: ${cluster.sourceCount ?? 1}  ·  Score: **${(cluster.relevanceScore ?? 0).toFixed(1)}**/10`,
    },
  })

  if (cluster.riskLevel === 'high') {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⚠️ **HIGH RISK** — Review carefully before approving' },
    })
  } else if (cluster.riskLevel === 'medium') {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⚠️ Medium risk — double check before approving' },
    })
  }

  for (const post of posts) {
    const badge = MODE_BADGES[post.contentMode] ?? post.contentMode
    const isPureNews = post.contentMode === 'pure_news'
    // Strip any URLs that might have slipped through in pure_news
    const displayContent = isPureNews
      ? post.content.replace(/https?:\/\/\S+/g, '').replace(/\n+$/, '').trim()
      : post.content

    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${badge}** ${isPureNews ? '_(no link — tweet only)_' : ''}  ·  Score: ${post.estimatedScore ?? 'N/A'}/10`,
      },
    })
    // Tweet content — using > blockquote instead of ``` code block
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: displayContent.split('\n').map(l => `> ${l}`).join('\n') },
    })
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `_${displayContent.length}/280 chars_` },
    })
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ Approve & Copy' },
          type: 'primary',
          value: JSON.stringify({ action: 'approve', postId: post.id }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✏️ Edit' },
          type: 'default',
          value: JSON.stringify({ action: 'edit', postId: post.id }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ Reject' },
          type: 'danger',
          value: JSON.stringify({ action: 'reject', postId: post.id }),
        },
      ],
    })
  }

  // Pause bot control at the bottom of every card
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '⏸ Pause Bot' },
        type: 'default',
        value: JSON.stringify({ action: 'pause_bot' }),
      },
    ],
  })

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📰 New posts ready for review' },
      template: headerTemplate(cluster.riskLevel ?? 'low'),
    },
    elements,
  }
}

export function buildBotStatusCard(paused: boolean): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: paused ? '⏸ Bot Paused' : '▶️ Bot Resumed' },
      template: paused ? 'grey' : 'green',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: paused
            ? 'SignalDesk bot is now **paused**. No new posts will be sent to this group until you resume.'
            : 'SignalDesk bot is now **active**. New high-scoring posts will be sent here automatically.',
        },
      },
      {
        tag: 'action',
        actions: [
          paused
            ? {
                tag: 'button',
                text: { tag: 'plain_text', content: '▶️ Resume Bot' },
                type: 'primary',
                value: JSON.stringify({ action: 'resume_bot' }),
              }
            : {
                tag: 'button',
                text: { tag: 'plain_text', content: '⏸ Pause Bot' },
                type: 'default',
                value: JSON.stringify({ action: 'pause_bot' }),
              },
        ],
      },
    ],
  }
}

function buildApprovalDMCard(post: GeneratedPost): object {
  const intentUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(post.content)
  const displayContent = post.content.split('\n').map(l => `> ${l}`).join('\n')
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ Post approved — ready to publish' },
      template: 'green',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: displayContent } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🐦 Open X to post' },
            type: 'primary',
            multi_url: {
              url: intentUrl,
              pc_url: intentUrl,
              ios_url: intentUrl,
              android_url: intentUrl,
            },
          },
        ],
      },
    ],
  }
}

function buildUpdatedCard(cluster: EventCluster, post: GeneratedPost, actorName: string, approved: boolean): object {
  const displayContent = post.content.split('\n').map(l => `> ${l}`).join('\n')
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: cluster.canonicalHeadline },
      template: approved ? 'green' : 'grey',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: approved
            ? `✅ **Approved** by ${actorName}`
            : `❌ **Rejected** by ${actorName}`,
        },
      },
      { tag: 'div', text: { tag: 'lark_md', content: displayContent } },
    ],
  }
}

function buildEditDMCard(post: GeneratedPost): object {
  const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/review`
  const displayContent = post.content.split('\n').map(l => `> ${l}`).join('\n')
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Edit this post' },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**✏️ Edit the post on the web dashboard**' } },
      { tag: 'div', text: { tag: 'lark_md', content: displayContent } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🖥️ Open Review Dashboard' },
            type: 'default',
            multi_url: {
              url: dashboardUrl,
              pc_url: dashboardUrl,
              ios_url: dashboardUrl,
              android_url: dashboardUrl,
            },
          },
        ],
      },
    ],
  }
}

export async function sendClusterToLark(cluster: EventCluster, posts: GeneratedPost[]): Promise<string | null> {
  const chatId = process.env.LARK_REVIEW_CHAT_ID
  if (!chatId) throw new Error('LARK_REVIEW_CHAT_ID not set')

  const card = buildReviewCard(cluster, posts)

  const result = await larkPost('/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  }) as { code: number; msg: string; data?: { message_id?: string } }

  if (result.code !== 0) throw new Error(`Lark send failed: ${result.msg}`)
  return (result.data as { message_id?: string })?.message_id ?? null
}

export async function updateGroupCard(
  messageId: string,
  cluster: EventCluster,
  post: GeneratedPost,
  actorName: string,
  approved: boolean
): Promise<void> {
  const card = buildUpdatedCard(cluster, post, actorName, approved)
  await larkPatch(`/im/v1/messages/${messageId}`, {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}

export async function sendApprovalDM(openId: string, post: GeneratedPost): Promise<void> {
  const card = buildApprovalDMCard(post)
  await larkPost('/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
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

export async function sendEditDM(openId: string, post: GeneratedPost): Promise<void> {
  const card = buildEditDMCard(post)
  await larkPost('/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
}
