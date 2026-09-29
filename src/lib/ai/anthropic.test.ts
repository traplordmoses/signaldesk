/**
 * The request/response contract that lets the model be changed by configuration.
 * Without it, switching ANTHROPIC_MODEL to a 5.5 model makes every call fail:
 * those models reject `temperature` (HTTP 400) and begin replies with thinking
 * blocks, so `content[0].text` is empty. Both were reproduced against the live API.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { messagesBody, responseText, stripFence, usesAdaptiveThinking } from './anthropic'

describe('usesAdaptiveThinking', () => {
  it('recognises the 5.5 generation and nothing else', () => {
    expect(usesAdaptiveThinking('claude-sonnet-5-5')).toBe(true)
    expect(usesAdaptiveThinking('claude-opus-5-5')).toBe(true)
    expect(usesAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false)
    expect(usesAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false)
  })
})

describe('messagesBody', () => {
  const req = { system: 'sys', user: 'hi', maxTokens: 600, temperature: 0.2 }
  afterEach(() => { delete process.env.ANTHROPIC_EFFORT })

  it('keeps today\'s request unchanged for Haiku', () => {
    expect(messagesBody('claude-haiku-4-5-20251001', req)).toEqual({
      model: 'claude-haiku-4-5-20251001', system: 'sys',
      messages: [{ role: 'user', content: 'hi' }], max_tokens: 600, temperature: 0.2,
    })
  })

  it('omits temperature for 5.5 models, which reject it', () => {
    expect(messagesBody('claude-sonnet-5-5', req)).not.toHaveProperty('temperature')
  })

  it('sets low effort and room for thinking on 5.5 models', () => {
    const body = messagesBody('claude-opus-5-5', req)
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.max_tokens).toBeGreaterThanOrEqual(4000)
  })

  it('lets ANTHROPIC_EFFORT override the effort level', () => {
    process.env.ANTHROPIC_EFFORT = 'medium'
    expect(messagesBody('claude-sonnet-5-5', req).output_config).toEqual({ effort: 'medium' })
  })
})

describe('responseText', () => {
  it('skips leading thinking blocks — the 5.5 response shape', () => {
    expect(responseText({ content: [
      { type: 'thinking', text: undefined },
      { type: 'text', text: '{"ok":' },
      { type: 'text', text: 'true}' },
    ] as Array<{ type?: string; text?: string }> })).toBe('{"ok":true}')
  })

  it('reads a plain Haiku response', () => {
    expect(responseText({ content: [{ type: 'text', text: 'hello' }] })).toBe('hello')
  })

  it('is empty-safe', () => {
    expect(responseText(undefined)).toBe('')
    expect(responseText({})).toBe('')
  })

  it('strips a json fence', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
})
