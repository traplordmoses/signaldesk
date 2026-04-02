import { sendClusterToLark } from './src/lib/lark/messages'

async function main() {
  const fakeCluster = {
    id: 'test-cluster-001',
    canonicalHeadline: 'TEST: SignalDesk Lark Integration Working',
    category: 'tech',
    relevanceScore: 8.5,
    riskLevel: 'low',
    riskReasons: '[]',
    sourceCount: 3,
    constituentItemIds: '[]',
    constituentSummaries: '["This is a test message to verify the Lark integration is working correctly."]',
    status: 'new',
    firstSeenAt: Date.now(),
    lastUpdatedAt: Date.now(),
    postCount: 0,
    topics: JSON.stringify(['🇺🇸 美国', '🇮🇷 伊朗', '💥 军事/冲突']),
  }

  const fakePosts = [
    {
      id: 'test-post-001',
      clusterId: 'test-cluster-001',
      contentMode: 'pure_news',
      content: 'BREAKING: SignalDesk Lark integration is now live and working.',
      marketLink: 'https://polymarket.com',
      charCount: 62,
      estimatedScore: 8.0,
      scoreExplanation: 'Test post for Lark integration verification.',
      status: 'pending',
      rejectionReason: null,
      postedAt: null,
      reviewedBy: null,
      larkMessageId: null,
      larkSentAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'test-post-002',
      clusterId: 'test-cluster-001',
      contentMode: 'news_odds',
      content: 'BREAKING: SignalDesk is now connected to Lark.\nApproval workflow is ready to use.\nhttps://polymarket.com',
      marketLink: 'https://polymarket.com',
      charCount: 110,
      estimatedScore: 7.5,
      scoreExplanation: 'Test post for approval workflow.',
      status: 'pending',
      rejectionReason: null,
      postedAt: null,
      reviewedBy: null,
      larkMessageId: null,
      larkSentAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'test-post-003',
      clusterId: 'test-cluster-001',
      contentMode: 'engagement',
      content: 'The SignalDesk bot is now live in your Lark group. When real news hits, posts will appear here for approval.\nReady to start monitoring?\nhttps://polymarket.com',
      marketLink: 'https://polymarket.com',
      charCount: 160,
      estimatedScore: 7.0,
      scoreExplanation: 'Test engagement post.',
      status: 'pending',
      rejectionReason: null,
      postedAt: null,
      reviewedBy: null,
      larkMessageId: null,
      larkSentAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]

  console.log('Sending test message to Lark...')
  const messageId = await sendClusterToLark(fakeCluster as any, fakePosts as any)

  if (messageId) {
    console.log('✅ 成功! Lark message sent, message_id:', messageId)
    console.log('Check your "testing" group in Lark — you should see a review card with 3 posts.')
  } else {
    console.log('❌ Failed to send message (no message_id returned)')
  }
}

main().catch(console.error)
