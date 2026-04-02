import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { handleLarkCallback } from '@/lib/lark/handler'

function verifyLarkSignature(
  timestamp: string,
  nonce: string,
  body: string,
  signature: string
): boolean {
  const appSecret = process.env.LARK_APP_SECRET ?? ''
  const str = timestamp + nonce + appSecret + body
  const computed = createHash('sha256').update(str).digest('hex')
  return computed === signature
}

export async function POST(req: NextRequest) {
  const bodyText = await req.text()

  // Handle URL verification challenge
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if ('challenge' in parsed) {
    return NextResponse.json({ challenge: parsed.challenge })
  }

  // Verify signature
  const timestamp = req.headers.get('x-lark-request-timestamp') ?? ''
  const nonce = req.headers.get('x-lark-request-nonce') ?? ''
  const signature = req.headers.get('x-lark-signature') ?? ''

  if (timestamp && nonce && signature) {
    if (!verifyLarkSignature(timestamp, nonce, bodyText, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // Handle card action callback
  try {
    const payload = parsed as {
      action?: { value?: string | { action?: string; postId?: string } }
      operator?: { open_id?: string; name?: string }
      context?: { open_message_id?: string }
    }

    if (!payload.action?.value || !payload.operator?.open_id) {
      return NextResponse.json({ code: 0 })
    }

    // Lark sends button value as a JSON string
    let actionValue: { action?: string; postId?: string } = {}
    if (typeof payload.action.value === 'string') {
      try { actionValue = JSON.parse(payload.action.value) } catch {}
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
