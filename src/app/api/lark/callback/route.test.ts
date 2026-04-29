/**
 * Regression coverage for the Lark callback signature verification path —
 * the original launch-blocker. Each test maps to a specific bypass that the
 * pre-patch code allowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'crypto'

vi.mock('@/lib/lark/handler', () => ({
  handleLarkCallback: vi.fn(async () => ({ code: 0, message: 'ok' })),
}))

// Import AFTER the mock so the route's import resolves to the mocked handler.
const { handleLarkCallback } = await import('@/lib/lark/handler')
const { POST } = await import('./route')

const SECRET = 'test-secret-do-not-use-in-prod'
const VERIFY_TOKEN = 'test-verification-token-do-not-use'
const ENCRYPT_KEY = 'test-encryption-key-do-not-use'

// Mirror of the production decryptLarkBody for test fixture generation.
function encryptForLark(plaintext: string, encryptionKey: string): string {
  const key = createHash('sha256').update(encryptionKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

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

// Schema 2.0 callbacks ship NO signature headers. Auth comes from header.token
// matching LARK_VERIFICATION_TOKEN, plus header.create_time freshness.
function schema2Body(opts: {
  eventType: string
  token?: string
  eventId?: string
  ageSec?: number
  event?: unknown
}): string {
  // microseconds — within Number.MAX_SAFE_INTEGER for ~285 years from now
  const createTimeMicros = String((Date.now() - (opts.ageSec ?? 0) * 1000) * 1000)
  return JSON.stringify({
    schema: '2.0',
    header: {
      event_id: opts.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
      token: opts.token ?? VERIFY_TOKEN,
      create_time: createTimeMicros,
      event_type: opts.eventType,
      tenant_key: 'tenant-x',
      app_id: 'cli_test',
    },
    event: opts.event ?? {},
  })
}

describe('POST /api/lark/callback — signature verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LARK_APP_SECRET = SECRET
    process.env.LARK_VERIFICATION_TOKEN = VERIFY_TOKEN
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

  it('accepts Schema 2.0 card action callbacks via header.token (no x-lark-* headers needed)', async () => {
    const bodyText = schema2Body({
      eventType: 'card.action.trigger',
      event: {
        action: { value: { action: 'approve', postId: 'p-modern' } },
        operator: { user_id: { open_id: 'ou-modern' }, user_name: 'Reviewer' },
        context: { open_message_id: 'om-modern' },
      },
    })

    const res = await POST(makeRequest(bodyText) as any)

    expect(res.status).toBe(200)
    expect(handleLarkCallback).toHaveBeenCalledWith({
      action: { value: { action: 'approve', postId: 'p-modern' } },
      operator: { open_id: 'ou-modern', name: 'Reviewer' },
      context: { open_message_id: 'om-modern' },
    })
  })

  it('rejects Schema 2.0 callbacks with wrong header.token', async () => {
    const bodyText = schema2Body({
      eventType: 'card.action.trigger',
      token: 'wrong-token',
      event: { action: { value: { action: 'approve', postId: 'p-x' } }, operator: { user_id: { open_id: 'ou-x' } } },
    })
    const res = await POST(makeRequest(bodyText) as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/token/i)
  })

  it('fails closed (500) when LARK_VERIFICATION_TOKEN is unset for Schema 2.0', async () => {
    delete process.env.LARK_VERIFICATION_TOKEN
    const bodyText = schema2Body({ eventType: 'card.action.trigger' })
    const res = await POST(makeRequest(bodyText) as any)
    expect(res.status).toBe(500)
  })

  it('rejects Schema 2.0 callbacks with stale create_time', async () => {
    const bodyText = schema2Body({ eventType: 'card.action.trigger', ageSec: 10 * 60 })
    const res = await POST(makeRequest(bodyText) as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/create_time/i)
  })

  it('passes card form values through for Lark-native edit saves', async () => {
    const bodyText = schema2Body({
      eventType: 'card.action.trigger',
      event: {
        action: {
          value: { action: 'save_edit', postId: 'p-edit' },
          form_value: { edited_content: 'Edited draft text.' },
        },
        operator: { user_id: { open_id: 'ou-editor' }, user_name: 'Editor' },
        context: { open_message_id: 'om-edit-dm' },
      },
    })

    const res = await POST(makeRequest(bodyText) as any)

    expect(res.status).toBe(200)
    expect(handleLarkCallback).toHaveBeenCalledWith({
      action: { value: { action: 'save_edit', postId: 'p-edit', editedContent: 'Edited draft text.' } },
      operator: { open_id: 'ou-editor', name: 'Editor' },
      context: { open_message_id: 'om-edit-dm' },
    })
  })

  it('no-ops on im.message.receive_v1 (Schema 2.0 inline edit removed the DM-receive path)', async () => {
    const bodyText = schema2Body({
      eventType: 'im.message.receive_v1',
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou-someone' } },
        message: { message_type: 'text', content: JSON.stringify({ text: 'Hello bot.' }) },
      },
    })
    const res = await POST(makeRequest(bodyText) as any)
    expect(res.status).toBe(200)
    expect(handleLarkCallback).not.toHaveBeenCalled()
  })

  it('fails closed (500) when encrypted body arrives but LARK_ENCRYPTION_KEY is unset', async () => {
    delete process.env.LARK_ENCRYPTION_KEY
    const res = await POST(makeRequest({ encrypt: 'irrelevant-base64-blob' }) as any)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/LARK_ENCRYPTION_KEY/i)
  })

  it('decrypts encrypted Schema 2.0 callbacks and dispatches', async () => {
    process.env.LARK_ENCRYPTION_KEY = ENCRYPT_KEY
    const inner = schema2Body({
      eventType: 'card.action.trigger',
      event: {
        action: { value: { action: 'approve', postId: 'p-encrypted' } },
        operator: { user_id: { open_id: 'ou-encrypted' }, user_name: 'Reviewer' },
        context: { open_message_id: 'om-encrypted' },
      },
    })
    const outer = JSON.stringify({ encrypt: encryptForLark(inner, ENCRYPT_KEY) })
    const res = await POST(makeRequest(outer) as any)
    expect(res.status).toBe(200)
    expect(handleLarkCallback).toHaveBeenCalledWith({
      action: { value: { action: 'approve', postId: 'p-encrypted' } },
      operator: { open_id: 'ou-encrypted', name: 'Reviewer' },
      context: { open_message_id: 'om-encrypted' },
    })
  })

  it('rejects (401) when decryption fails (wrong key)', async () => {
    process.env.LARK_ENCRYPTION_KEY = 'totally-different-key'
    const inner = schema2Body({ eventType: 'card.action.trigger' })
    const outer = JSON.stringify({ encrypt: encryptForLark(inner, ENCRYPT_KEY) })
    const res = await POST(makeRequest(outer) as any)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/decrypt/i)
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
