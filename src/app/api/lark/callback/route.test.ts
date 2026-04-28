/**
 * Regression coverage for the Lark callback signature verification path —
 * the original launch-blocker. Each test maps to a specific bypass that the
 * pre-patch code allowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

vi.mock('@/lib/lark/handler', () => ({
  handleLarkCallback: vi.fn(async () => ({ code: 0, message: 'ok' })),
}))

// Import AFTER the mock so the route's import resolves to the mocked handler.
const { handleLarkCallback } = await import('@/lib/lark/handler')
const { POST } = await import('./route')

const SECRET = 'test-secret-do-not-use-in-prod'

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/lark/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function signedHeaders(bodyText: string, opts: { ageSec?: number; nonce?: string } = {}) {
  const ts = String(Math.floor(Date.now() / 1000) - (opts.ageSec ?? 0))
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`
  const signature = createHash('sha256').update(ts + nonce + SECRET + bodyText).digest('hex')
  return {
    'x-lark-request-timestamp': ts,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  }
}

describe('POST /api/lark/callback — signature verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LARK_APP_SECRET = SECRET
  })

  it('echoes valid url_verification challenges (the only unauthenticated path)', async () => {
    const res = await POST(makeRequest({ type: 'url_verification', challenge: 'abc123' }) as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: 'abc123' })
  })

  it('rejects malformed challenge bodies that lack type:url_verification', async () => {
    // Pre-patch this would echo "evil" as the challenge — abuse vector.
    const res = await POST(makeRequest({ challenge: 'evil' }) as any)
    expect(res.status).toBe(401)
  })

  it('fails closed (500) when LARK_APP_SECRET is unset', async () => {
    delete process.env.LARK_APP_SECRET
    const res = await POST(makeRequest({ action: { value: '{}' } }) as any)
    expect(res.status).toBe(500)
  })

  it('rejects requests missing any of the 3 signature headers', async () => {
    // Pre-patch this ran the handler. Now: 401.
    const res = await POST(makeRequest({ action: { value: '{}' } }) as any)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/signature/i)
  })

  it('rejects timestamps older than ±5 minutes (replay window)', async () => {
    const bodyText = JSON.stringify({ action: { value: '{}' }, operator: { open_id: 'x' } })
    const headers = signedHeaders(bodyText, { ageSec: 10 * 60 })  // 10 min ago
    const res = await POST(makeRequest(bodyText, headers) as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/timestamp/i)
  })

  it('rejects requests with an invalid signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const headers = {
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': 'n-bad',
      'x-lark-signature': 'wrong'.padEnd(64, 'x'),
    }
    const res = await POST(makeRequest({ action: { value: '{}' } }, headers) as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/signature/i)
  })

  it('accepts a properly signed, fresh, well-formed request', async () => {
    const bodyText = JSON.stringify({
      action: { value: '{"action":"approve","postId":"p1"}' },
      operator: { open_id: 'op-test' },
    })
    const res = await POST(makeRequest(bodyText, signedHeaders(bodyText)) as any)
    expect(res.status).toBe(200)
  })

  it('accepts modern event-wrapped card action callbacks', async () => {
    const bodyText = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: {
        action: { value: { action: 'approve', postId: 'p-modern' } },
        operator: { user_id: { open_id: 'ou-modern' }, user_name: 'Reviewer' },
        context: { open_message_id: 'om-modern' },
      },
    })

    const res = await POST(makeRequest(bodyText, signedHeaders(bodyText)) as any)

    expect(res.status).toBe(200)
    expect(handleLarkCallback).toHaveBeenCalledWith({
      action: { value: { action: 'approve', postId: 'p-modern' } },
      operator: { open_id: 'ou-modern', name: 'Reviewer' },
      context: { open_message_id: 'om-modern' },
    })
  })

  it('rejects replays of an already-seen nonce', async () => {
    const bodyText = JSON.stringify({
      action: { value: '{"action":"approve","postId":"p2"}' },
      operator: { open_id: 'op-test' },
    })
    const headers = signedHeaders(bodyText, { nonce: 'fixed-replay-nonce' })

    const first = await POST(makeRequest(bodyText, headers) as any)
    expect(first.status).toBe(200)

    const second = await POST(makeRequest(bodyText, headers) as any)
    expect(second.status).toBe(401)
    expect((await second.json()).error).toMatch(/replay/i)
  })
})
