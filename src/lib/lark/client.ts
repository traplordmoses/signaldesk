const LARK_BASE = 'https://open.larksuite.com/open-apis'

interface TokenCache {
  token: string
  expiresAt: number
}

let tokenCache: TokenCache | null = null

export async function getTenantAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token
  }

  const appId = process.env.LARK_APP_ID
  const appSecret = process.env.LARK_APP_SECRET

  if (!appId || !appSecret) throw new Error('LARK_APP_ID or LARK_APP_SECRET not set')

  const res = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })

  if (!res.ok) throw new Error(`Lark auth failed: ${res.status}`)

  const data = await res.json() as { tenant_access_token: string; expire: number; code: number; msg: string }
  if (data.code !== 0) throw new Error(`Lark auth error: ${data.msg}`)

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 60) * 1000,
  }

  return tokenCache.token
}

export async function larkPost(path: string, body: unknown): Promise<{ code: number; msg: string; data?: unknown }> {
  const token = await getTenantAccessToken()

  const res = await fetch(`${LARK_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) throw new Error(`Lark API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<{ code: number; msg: string; data?: unknown }>
}

export async function larkPatch(path: string, body: unknown): Promise<{ code: number; msg: string }> {
  const token = await getTenantAccessToken()

  const res = await fetch(`${LARK_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) throw new Error(`Lark PATCH error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<{ code: number; msg: string }>
}
