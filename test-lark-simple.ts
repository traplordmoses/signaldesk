import { getTenantAccessToken } from './src/lib/lark/client'

async function main() {
  const chatId = process.env.LARK_REVIEW_CHAT_ID!
  console.log('Using chat_id:', chatId)

  const token = await getTenantAccessToken()
  console.log('✅ Got token')

  // Test 1: simple text message
  const res = await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: 'SignalDesk test message — if you see this, the bot can send to your group! ✅' }),
    }),
  })

  const data = await res.json()
  console.log('Response:', JSON.stringify(data, null, 2))

  if (data.code === 0) {
    console.log('\n✅ 成功! Text message sent to Lark group.')
  } else {
    console.log('\n❌ Failed:', data.msg)
    if (data.code === 230001) {
      console.log('\n可能原因:')
      console.log('1. Bot 没有在群里 — 请确认已添加 SignalDesk Bot 到群聊')
      console.log('2. 没有 im:message 权限 — 请到 Lark 开发者平台添加权限')
    }
  }
}

main().catch(console.error)
