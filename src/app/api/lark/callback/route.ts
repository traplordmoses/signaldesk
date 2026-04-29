export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { createDecipheriv, createHash } from 'crypto'
import { handleLarkCallback } from '@/lib/lark/handler'

// Lark encrypts the entire callback body when "Encryption Strategy" is on.
// Format: { "encrypt": "<base64>" } where the decoded buffer is
// 16 bytes IV + AES-256-CBC ciphertext, and the AES key is SHA-256 of
// the encryption-key string configured in the dev console.
function decryptLarkBody(encrypted: string, encryptionKey: string): string {
  const buf = Buffer.from(encrypted, 'base64')
  if (buf.length <= 16) throw new Error('encrypted body too short')
  const iv = buf.subarray(0, 16)
  const ciphertext = buf.subarray(16)
  const key = createHash('sha256').update(encryptionKey).digest()
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return out.toString('utf8')
}

const TIMESTAMP_FRESHNESS_SEC = 5 * 60       // accept timestamps within ±5 min
const NONCE_RETENTION_MS = 6 * 60 * 1000     // remember nonces for 6 min (5 min window + buffer)

// In-memory nonce store. Single-process app, restarts wipe it but the timestamp
// freshness check prevents replays older than ±5 min anyway.
const seenNonces = new Map<string, number>()

type LarkCallbackObject = Record<string, unknown>

function asObject(value: unknown): LarkCallbackObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as LarkCallbackObject
    : undefined
}

function getString(obj: LarkCallbackObject | undefined, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' ? value : undefined
}

function parseActionValue(value: unknown): { action?: string; postId?: string; editedContent?: string } {
  let parsedValue: unknown = value
  if (typeof value === 'string') {
    try {
      parsedValue = JSON.parse(value)
    } catch (e) {
      console.error(`lark callback: malformed action.value JSON: ${(e as Error).message}`)
      return {}
    }
  }

  const obj = asObject(parsedValue)
  if (!obj) return {}

  return {
    action: getString(obj, 'action'),
    postId: getString(obj, 'postId') ?? getString(obj, 'post_id'),
    editedContent: getString(obj, 'editedContent') ?? getString(obj, 'edited_content'),
  }
}

function extractFormString(actionObj: LarkCallbackObject | undefined, eventObj: LarkCallbackObject | undefined, key: string): string | undefined {
  const candidateContainers = [
    asObject(actionObj?.form_value),
    asObject(actionObj?.formValue),
    asObject(actionObj?.input_value),
    asObject(actionObj?.inputValue),
    asObject(eventObj?.form_value),
    asObject(eventObj?.formValue),
  ]

  for (const container of candidateContainers) {
    const direct = getString(container, key)
    if (direct !== undefined) return direct

    const nested = asObject(container?.[key])
    const nestedValue = getString(nested, 'value') ?? getString(nested, 'text')
    if (nestedValue !== undefined) return nestedValue
  }

  return undefined
}

function normalizeCardActionCallback(parsed: LarkCallbackObject): {
  action?: string
  postId?: string
  openId?: string
  actorName?: string
  openMessageId?: string
  editedContent?: string
} {
  // Lark can deliver card action callbacks either as the older direct shape:
  // { action, operator, context } or the newer event-wrapper shape:
  // { header, event: { action, operator, context } }.
  const event = asObject(parsed.event)
  const actionObj = asObject(event?.action) ?? asObject(parsed.action)
  const operatorObj = asObject(event?.operator) ?? asObject(parsed.operator)
  const contextObj = asObject(event?.context) ?? asObject(parsed.context)
  const userIdObj = asObject(operatorObj?.user_id)

  const actionValue = parseActionValue(actionObj?.value)
  const editedContent = actionValue.editedContent ?? extractFormString(actionObj, event, 'edited_content')

  return {
    action: actionValue.action,
    postId: actionValue.postId,
    openId:
      getString(operatorObj, 'open_id') ??
      getString(userIdObj, 'open_id'),
    actorName:
      getString(operatorObj, 'name') ??
      getString(operatorObj, 'user_name') ??
      getString(userIdObj, 'open_id'),
    openMessageId:
      getString(contextObj, 'open_message_id') ??
      getString(asObject(event?.message), 'open_message_id'),
    editedContent,
  }
}

function gcNonces(now: number) {
  for (const [k, expiry] of seenNonces.entries()) {
    if (expiry < now) seenNonces.delete(k)
  }
}

function verifyLarkSignature(
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
  appSecret: string,
): boolean {
  const computed = createHash('sha256')
    .update(timestamp + nonce + appSecret + body)
    .digest('hex')
  return computed === signature
}

export async function POST(req: NextRequest) {
  const bodyText = await req.text()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // If the dev console has "Encryption Strategy" enabled, every inbound body
  // (including the URL-verification challenge) arrives as { "encrypt": "<b64>" }
  // and we need to decrypt before doing anything else. Without the key set, we
  // fail closed — accepting an undecrypted body would mean either accepting
  // garbage or accepting an attacker who guessed the structure.
  if (typeof parsed.encrypt === 'string') {
    const encryptKey = process.env.LARK_ENCRYPTION_KEY
    if (!encryptKey) {
      return NextResponse.json(
        { error: 'Server not configured (LARK_ENCRYPTION_KEY)' },
        { status: 500 },
      )
    }
    try {
      const plaintext = decryptLarkBody(parsed.encrypt, encryptKey)
      parsed = JSON.parse(plaintext) as Record<string, unknown>
    } catch (e) {
      console.error('lark callback: decrypt failed:', (e as Error).message)
      return NextResponse.json({ error: 'Decryption failed' }, { status: 401 })
    }
  }

  // URL verification challenge — Lark sends this WITHOUT signature headers when
  // first registering the callback URL. Restrict to actual challenge payloads to
  // avoid abuse of the unauthenticated path.
  if (
    'challenge' in parsed &&
    typeof parsed.challenge === 'string' &&
    parsed.type === 'url_verification'
  ) {
    return NextResponse.json({ challenge: parsed.challenge })
  }

  // After URL verification, every callback MUST be authenticated. Lark uses two
  // different schemes:
  //   - Legacy (Schema 1.0 / *_v1 callbacks): x-lark-signature header signed
  //     with LARK_APP_SECRET, plus x-lark-request-timestamp + nonce.
  //   - Schema 2.0 (card.action.trigger, im.message.receive_v1, ...): NO headers.
  //     Body contains header.token (must equal LARK_VERIFICATION_TOKEN),
  //     header.create_time (microseconds, for freshness), header.event_id
  //     (for replay protection).
  //
  // Detect Schema 2.0 via `schema === '2.0'` or by presence of header.token,
  // and verify with the appropriate scheme.
  const isSchema2 =
    parsed.schema === '2.0' ||
    (typeof parsed.header === 'object' && parsed.header !== null && 'token' in (parsed.header as Record<string, unknown>))

  const nowMs = Date.now()

  if (isSchema2) {
    const expectedToken = process.env.LARK_VERIFICATION_TOKEN
    if (!expectedToken) {
      return NextResponse.json({ error: 'Server not configured (LARK_VERIFICATION_TOKEN)' }, { status: 500 })
    }

    const header = asObject(parsed.header)
    const receivedToken = getString(header, 'token') ?? ''
    const eventId = getString(header, 'event_id') ?? ''
    const createTimeRaw = getString(header, 'create_time') ?? ''

    if (!receivedToken || receivedToken !== expectedToken) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // create_time is microseconds → ms
    const createTimeMs = Number(createTimeRaw) / 1000
    if (!Number.isFinite(createTimeMs) || Math.abs(nowMs - createTimeMs) > TIMESTAMP_FRESHNESS_SEC * 1000) {
      return NextResponse.json({ error: 'Stale or invalid create_time' }, { status: 401 })
    }

    // Replay protection via event_id (in-memory store, namespaced).
    gcNonces(nowMs)
    const replayKey = `evt:${eventId}`
    if (eventId && seenNonces.has(replayKey)) {
      return NextResponse.json({ error: 'Replay detected' }, { status: 401 })
    }
    if (eventId) seenNonces.set(replayKey, nowMs + NONCE_RETENTION_MS)
  } else {
    // Legacy header-signature path (Schema 1.0 / *_v1 callbacks)
    const appSecret = process.env.LARK_APP_SECRET
    if (!appSecret) {
      return NextResponse.json({ error: 'Server not configured (LARK_APP_SECRET)' }, { status: 500 })
    }

    const timestamp = req.headers.get('x-lark-request-timestamp')
    const nonce = req.headers.get('x-lark-request-nonce')
    const signature = req.headers.get('x-lark-signature')

    if (!timestamp || !nonce || !signature) {
      return NextResponse.json({ error: 'Missing signature headers' }, { status: 401 })
    }

    const tsSec = parseInt(timestamp, 10)
    const nowSec = Math.floor(nowMs / 1000)
    if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > TIMESTAMP_FRESHNESS_SEC) {
      return NextResponse.json({ error: 'Stale or invalid timestamp' }, { status: 401 })
    }

    if (!verifyLarkSignature(timestamp, nonce, bodyText, signature, appSecret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    gcNonces(nowMs)
    if (seenNonces.has(nonce)) {
      return NextResponse.json({ error: 'Replay detected' }, { status: 401 })
    }
    seenNonces.set(nonce, nowMs + NONCE_RETENTION_MS)
  }

  // Past this point the request is signed, fresh, and not a replay — body is trusted.
  try {
    const eventType = getString(asObject(parsed.header), 'event_type') ?? getString(parsed, 'type')

    // We no longer subscribe to im.message.receive_v1 — Schema 2.0 cards put the
    // edit field inline in the group chat, so we don't need to listen for DMs.
    // If Lark still pushes one (subscription leftover), no-op.
    if (eventType === 'im.message.receive_v1') {
      return NextResponse.json({ code: 0 })
    }

    const normalized = normalizeCardActionCallback(parsed)

    if (!normalized.action || !normalized.openId) {
      console.warn('lark callback: ignored payload without action/open_id', {
        eventType,
        hasAction: Boolean(normalized.action),
        hasOpenId: Boolean(normalized.openId),
      })
      return NextResponse.json({ code: 0 })
    }

    console.log('lark callback: action received', {
      action: normalized.action,
      postId: normalized.postId,
      hasMessageId: Boolean(normalized.openMessageId),
      hasEditedContent: Boolean(normalized.editedContent),
    })

    const callbackValue: {
      action: 'approve' | 'reject' | 'save_edit' | 'pause_bot' | 'resume_bot'
      postId?: string
      editedContent?: string
    } = {
      action: normalized.action as 'approve' | 'reject' | 'save_edit' | 'pause_bot' | 'resume_bot',
      postId: normalized.postId,
    }
    if (normalized.editedContent !== undefined) callbackValue.editedContent = normalized.editedContent

    const result = await handleLarkCallback({
      action: {
        value: callbackValue,
      },
      operator: {
        open_id: normalized.openId,
        name: normalized.actorName,
      },
      context: {
        open_message_id: normalized.openMessageId ?? '',
      },
    })

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ code: 1, error: message })
  }
}
