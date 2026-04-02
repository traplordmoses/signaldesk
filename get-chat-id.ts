async function main() {
  const APP_ID = 'cli_a940d78cf7f89e18'
  const APP_SECRET = 'DeGEKCq4pvwOIbxAFHbbZe35JQvvzERt'

  const tokenRes = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  const tokenData = await tokenRes.json() as { tenant_access_token: string; code: number; msg: string }

  if (tokenData.code !== 0) {
    console.error('获取 token 失败:', tokenData.msg)
    process.exit(1)
  }

  const token = tokenData.tenant_access_token
  console.log('✅ Token 获取成功\n')

  const chatsRes = await fetch('https://open.larksuite.com/open-apis/im/v1/chats?page_size=20', {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  const chatsData = await chatsRes.json() as { code: number; msg: string; data?: { items?: Array<{ chat_id: string; name: string }> } }

  if (chatsData.code !== 0) {
    console.error('获取群列表失败:', chatsData.msg)
    process.exit(1)
  }

  const chats = chatsData.data?.items ?? []
  if (chats.length === 0) {
    console.log('没有找到任何群，请确认 Bot 已加入群聊')
  } else {
    console.log('找到以下群聊：\n')
    for (const chat of chats) {
      console.log(`名称: ${chat.name}`)
      console.log(`chat_id: ${chat.chat_id}`)
      console.log('---')
    }
  }
}

main().catch(console.error)
