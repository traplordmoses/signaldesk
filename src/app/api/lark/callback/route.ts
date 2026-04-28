export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { handleLarkCallback, handleLarkMessage } from '@/lib/lark/handler'

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

function parseLarkTextMessageContent(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined
  try {
    const parsedContent = JSON.parse(content) as Record<string, unknown>
    const text = parsedContent.text
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

function normalizeMessageReceiveCallback(parsed: LarkCallbackObject): {
  openId?: string
  actorName?: string
  text?: string
} {
  const event = asObject(parsed.event)
  const sender = asObject(event?.sender)
  const senderId = asObject(sender?.sender_id)
  const message = asObject(event?.message)

  return {
    openId: getString(senderId, 'open_id'),
    actorName: getString(sender, 'sender_type') === 'user' ? getString(senderId, 'open_id') : undefined,
    text: parseLarkTextMessageContent(message?.content),
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

  // After URL verification, every callback MUST be signed.
  const appSecret = process.env.LARK_APP_SECRET
  if (!appSecret) {
    // Server misconfiguration — fail closed instead of accepting unsigned callbacks.
    return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  }

  const timestamp = req.headers.get('x-lark-request-timestamp')
  const nonce = req.headers.get('x-lark-request-nonce')
  const signature = req.headers.get('x-lark-signature')

  if (!timestamp || !nonce || !signature) {
    return NextResponse.json({ error: 'Missing signature headers' }, { status: 401 })
  }

  // Timestamp freshness: rejects replay attempts older than ±5 min.
  const tsSec = parseInt(timestamp, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > TIMESTAMP_FRESHNESS_SEC) {
    return NextResponse.json({ error: 'Stale or invalid timestamp' }, { status: 401 })
  }

  // Signature must match before we consider the body trusted.
  if (!verifyLarkSignature(timestamp, nonce, bodyText, signature, appSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Nonce replay: even with a valid signature, reject duplicates within the freshness window.
  const nowMs = Date.now()
  gcNonces(nowMs)
  if (seenNonces.has(nonce)) {
    return NextResponse.json({ error: 'Replay detected' }, { status: 401 })
  }
  seenNonces.set(nonce, nowMs + NONCE_RETENTION_MS)

  // Past this point the request is signed, fresh, and not a replay — body is trusted.
  try {
    const eventType = getString(asObject(parsed.header), 'event_type') ?? getString(parsed, 'type')

    if (eventType === 'im.message.receive_v1') {
      const message = normalizeMessageReceiveCallback(parsed)
      if (!message.openId || !message.text) return NextResponse.json({ code: 0 })
      const result = await handleLarkMessage({
        openId: message.openId,
        actorName: message.actorName,
        text: message.text,
      })
      return NextResponse.json(result)
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
      action: 'approve' | 'reject' | 'edit' | 'save_edit' | 'pause_bot' | 'resume_bot'
      postId?: string
      editedContent?: string
    } = {
      action: normalized.action as 'approve' | 'reject' | 'edit' | 'save_edit' | 'pause_bot' | 'resume_bot',
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
