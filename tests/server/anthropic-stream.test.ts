import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  anthropicPingIntervalMsFromEnv,
  createAnthropicMessagesStream,
} from '../../src/main/proxy/anthropic/stream.ts'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function parsedEvents(output: string): Array<Record<string, any>> {
  return output
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const data = frame.split('\n').find(line => line.startsWith('data: '))
      assert.ok(data, `missing data field in frame: ${frame}`)
      return JSON.parse(data.slice(6))
    })
}

function createFixture(callbacks?: {
  onSuccess?: () => void
  onFailure?: (error: Error) => void
  pingIntervalMs?: number
}) {
  const source = new PassThrough()
  const output = createAnthropicMessagesStream(source, {
    messageId: 'msg_fixture',
    model: 'fixture-model',
    pingIntervalMs: callbacks?.pingIntervalMs ?? 0,
    onSuccess: callbacks?.onSuccess,
    onFailure: callbacks?.onFailure,
  })
  let body = ''
  output.setEncoding('utf8')
  output.on('data', chunk => { body += chunk })
  return { source, output, body: () => body }
}

test('Anthropic stream parses fragmented SSE and emits ordered reasoning, text, and tool blocks', async () => {
  let successes = 0
  let failures = 0
  const fixture = createFixture({
    onSuccess: () => { successes += 1 },
    onFailure: () => { failures += 1 },
  })
  const ended = once(fixture.output, 'end')
  const frames = [
    { choices: [{ delta: { reasoning_content: 'inspect' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'ready' }, finish_reason: null }] },
    {
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'toolu_1', function: { name: 'read_file', arguments: '{"pa' } }] },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] },
        finish_reason: null,
      }],
    },
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('')

  for (let offset = 0; offset < frames.length; offset += 7) {
    fixture.source.write(frames.slice(offset, offset + 7))
  }
  fixture.source.end('data: [DONE]\n\n')
  await ended

  const events = parsedEvents(fixture.body())
  assert.equal(events[0].type, 'message_start')
  assert.deepEqual(
    events.filter(event => event.type === 'content_block_start').map(event => [event.index, event.content_block.type]),
    [[0, 'thinking'], [1, 'text'], [2, 'tool_use']],
  )
  assert.equal(events.find(event => event.delta?.type === 'thinking_delta')?.delta.thinking, 'inspect')
  assert.equal(events.find(event => event.delta?.type === 'text_delta')?.delta.text, 'ready')
  assert.equal(
    events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''),
    '{"path":"a.txt"}',
  )
  assert.equal(events.at(-2)?.delta?.stop_reason, 'tool_use')
  assert.equal(events.at(-2)?.usage?.output_tokens, 7)
  assert.equal(events.at(-1)?.type, 'message_stop')
  assert.equal(successes, 1)
  assert.equal(failures, 0)
})

test('Anthropic stream treats the OpenAI DONE marker as a terminal event', async () => {
  let successes = 0
  const fixture = createFixture({ onSuccess: () => { successes += 1 } })
  const ended = once(fixture.output, 'end')
  fixture.source.end('data: [DONE]\n\n')
  await ended

  const events = parsedEvents(fixture.body())
  assert.deepEqual(events.map(event => event.type), ['message_start', 'message_delta', 'message_stop'])
  assert.equal(events[1].delta.stop_reason, 'end_turn')
  assert.equal(successes, 1)
})

test('Anthropic stream returns a structured error for premature upstream EOF', async () => {
  const errors: Error[] = []
  const fixture = createFixture({ onFailure: error => errors.push(error) })
  const ended = once(fixture.output, 'end')
  fixture.source.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
  await ended

  const events = parsedEvents(fixture.body())
  assert.equal(events.at(-1)?.type, 'error')
  assert.match(events.at(-1)?.error?.message, /ended before a terminal/i)
  assert.equal(events.some(event => event.type === 'message_stop'), false)
  assert.equal(errors.length, 1)
})

test('Anthropic stream forwards upstream errors without reporting success', async () => {
  let successes = 0
  const errors: Error[] = []
  const fixture = createFixture({
    onSuccess: () => { successes += 1 },
    onFailure: error => errors.push(error),
  })
  const ended = once(fixture.output, 'end')
  fixture.source.end('data: {"error":{"message":"synthetic upstream failure"}}\n\n')
  await ended

  const events = parsedEvents(fixture.body())
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(events.at(-1)?.error?.message, 'synthetic upstream failure')
  assert.equal(successes, 0)
  assert.equal(errors.length, 1)
})

test('Anthropic stream emits protocol-native ping events while upstream is silent', async () => {
  const fixture = createFixture({ pingIntervalMs: 10 })
  await wait(35)
  const events = parsedEvents(fixture.body())
  assert.equal(events[0].type, 'message_start')
  assert.ok(events.filter(event => event.type === 'ping').length >= 2)

  const ended = once(fixture.output, 'end')
  fixture.source.end('data: [DONE]\n\n')
  await ended
})

test('Anthropic stream propagates client cancellation and destroys its upstream source', async () => {
  const errors: Array<Error & { status?: number; code?: string }> = []
  const fixture = createFixture({ onFailure: error => errors.push(error) })
  fixture.output.destroy()
  await once(fixture.output, 'close')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(errors.length, 1)
  assert.equal(errors[0].status, 499)
  assert.equal(errors[0].code, 'client_disconnected')
  assert.equal(fixture.source.destroyed, true)
})

test('Anthropic ping interval is configurable and rejects invalid values', () => {
  const previous = process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS
  try {
    process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS = '3210'
    assert.equal(anthropicPingIntervalMsFromEnv(), 3210)
    process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS = '0'
    assert.equal(anthropicPingIntervalMsFromEnv(), 0)
    process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS = 'invalid'
    assert.equal(anthropicPingIntervalMsFromEnv(), 15_000)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS
    else process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS = previous
  }
})
