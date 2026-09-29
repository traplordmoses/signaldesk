/**
 * Model-aware request building and response reading for every Claude call.
 *
 * Why this exists: the 5.5-generation models (claude-sonnet-5-5, claude-opus-5-5)
 * changed the Messages API contract in three ways that break naive callers:
 *
 *   1. `temperature` / `top_p` / `top_k` at any non-default value → HTTP 400.
 *   2. Adaptive thinking is always on and cannot be disabled. The response can
 *      START with `thinking` blocks, so reading `content[0].text` returns nothing.
 *   3. Thinking counts against `max_tokens`, so a budget sized for the text alone
 *      can truncate the JSON reply.
 *
 * Before this helper, all five call sites sent `temperature` and read
 * `content[0].text`. Setting ANTHROPIC_MODEL to a 5.5 model would have made every
 * draft, evidence check, rating and alias lookup fail — the bot would go silent
 * without a single error it wasn't already catching. With it, changing the model
 * is a configuration change. Effort for these short, structured tasks defaults to
 * `low` (ANTHROPIC_EFFORT overrides); thinking is billed as output.
 */

/** Models with always-on adaptive thinking that reject sampling parameters. */
export function usesAdaptiveThinking(model: string): boolean {
  return /(?:^|-)5-5(?:$|-)/.test(model)
}

export interface MessageRequest {
  system: string
  user: string
  /** Budget for the visible reply. Raised automatically for thinking models. */
  maxTokens: number
  /** Ignored for models that reject it. */
  temperature?: number
}

export function messagesBody(model: string, req: MessageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  }
  if (usesAdaptiveThinking(model)) {
    // Thinking shares the budget: leave generous room so it can't truncate the JSON.
    body.max_tokens = Math.max(req.maxTokens * 4, 4000)
    body.output_config = { effort: process.env.ANTHROPIC_EFFORT ?? 'low' }
  } else {
    body.max_tokens = req.maxTokens
    if (req.temperature != null) body.temperature = req.temperature
  }
  return body
}

/** All visible text in a response, selected by block type (never by position). */
export function responseText(data: { content?: Array<{ type?: string; text?: string }> } | null | undefined): string {
  return (data?.content ?? [])
    .filter(b => (b.type === undefined || b.type === 'text') && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
}

/** Strip a ```json fence the model sometimes wraps around structured output. */
export function stripFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}
