export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { handleLarkCallback } from '@/lib/lark/handler'

const TIMESTAMP_FRESHNESS_SEC = 5 * 60       // accept timestamps within ±5 min
const NONCE_RETENTION_MS = 6 * 60 * 1000     // remember nonces for 6 min (5 min window + buffer)

// In-memory nonce store. Single-process app, restarts wipe it but the timestamp
// freshness check prevents replays older than ±5 min anyway.
const seenNonces = new Map<string, number>()

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
    const payload = parsed as {
      action?: { value?: string | { action?: string; postId?: string } }
      operator?: { open_id?: string; name?: string }
      context?: { open_message_id?: string }
    }

    if (!payload.action?.value || !payload.operator?.open_id) {
      return NextResponse.json({ code: 0 })
    }

    let actionValue: { action?: string; postId?: string } = {}
    if (typeof payload.action.value === 'string') {
      try {
        actionValue = JSON.parse(payload.action.value)
      } catch (e) {
        console.error(`lark callback: malformed action.value JSON: ${(e as Error).message}`)
      }
    } else {
      actionValue = payload.action.value
    }

    const result = await handleLarkCallback({
      action: {
        value: {
          action: actionValue.action as 'approve' | 'reject' | 'edit' | 'pause_bot' | 'resume_bot',
          postId: actionValue.postId,
        },
      },
      operator: {
        open_id: payload.operator.open_id,
        name: payload.operator.name,
      },
      context: {
        open_message_id: payload.context?.open_message_id ?? '',
      },
    })

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ code: 1, error: message })
  }
}
