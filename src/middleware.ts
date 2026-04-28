import { NextRequest, NextResponse } from 'next/server'

// Bearer-token auth on /api/* — except the Lark callback, which has its own
// signature verification, and /api/health, which is a public probe.
// Token is read from BOT_API_TOKEN (server-only, NEVER exposed to the browser).
//
// In development (NODE_ENV !== 'production') we skip the check so the local
// dashboard "just works." For production:
//   - Put the dashboard host behind Cloudflare Access, basic auth, or a VPN —
//     the dashboard is for internal operators only.
//   - The bearer token protects /api/* against direct external callers (curl, scanners).
//
// Do NOT use NEXT_PUBLIC_BOT_API_TOKEN — anything NEXT_PUBLIC_* ships in the
// client JS bundle, defeating the point. Dashboard auth must come from a proxy
// in front of the whole site, not a token baked into the client.

const PUBLIC_API_PATHS = new Set<string>([
  '/api/lark/callback',  // signature-verified
  '/api/health',         // monitoring probe — no PII or secrets in response
])

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next()

  // Local dev: allow everything. The threat model is the public droplet, not localhost.
  if (process.env.NODE_ENV !== 'production') return NextResponse.next()

  const expected = process.env.BOT_API_TOKEN
  if (!expected) {
    return NextResponse.json(
      { error: 'BOT_API_TOKEN not configured on the server' },
      { status: 500 },
    )
  }

  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
