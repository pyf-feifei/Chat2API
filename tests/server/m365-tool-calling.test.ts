import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { flattenManagedTranscript } from '../../src/main/proxy/toolCalling/m365Transcript.ts'
import type { Provider } from '../../src/main/store/types.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'

function makeProvider(id: string): Provider {
  return {
    id, name: id, type: 'builtin', authType: 'token',
    apiEndpoint: 'https://example.invalid', headers: {}, enabled: true,
    createdAt: 0, updatedAt: 0,
  } as Provider
}

const tools = [{
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}]

function transformManaged(messages: unknown[]) {
  const engine = new ToolCallingEngine()
  return engine.transformRequest({
    request: { model: 'gpt-5.6-sol', messages, tools, tool_choice: 'auto' } as unknown as ChatCompletionRequest,
    provider: makeProvider('m365-copilot'),
    providerProfileKey: 'm365-copilot',
    actualModel: 'gpt-5.6-sol',
  })
}

function makeBaseChunk(text: string) {
  return {
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.6-sol',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
}

test('m365 managed transcript uses fenced protocol and role-labelled blocks', () => {
  const transformed = transformManaged([
    { role: 'system', content: 'Client system rules.' },
    { role: 'user', content: 'What is the weather in Paris?' },
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    }] },
    { role: 'tool', tool_call_id: 'call_1', content: '18C sunny' },
    { role: 'user', content: 'Now compare with London.' },
  ])
  assert.equal(transformed.plan.shouldParseResponse, true)
  assert.equal(transformed.plan.protocol, 'm365_fenced')

  const text = flattenManagedTranscript(transformed.messages as any)
  assert.match(text, /## Available Tools/)
  // System blocks ride the text channel WITHOUT a [system] role label — the
  // consumer safety layer blocks forged [system] tags (bisected 2026-08-28).
  assert.match(text, /Client system rules\./)
  assert.doesNotMatch(text, /\[system\]/)
  assert.match(text, /\[user\]\nWhat is the weather in Paris\?/)
  assert.match(text, /\[assistant\]\n```get_weather\n/)
  assert.match(text, /\[tool\]\n<tool_response name="get_weather" call_id="call_1">\n18C sunny\n<\/tool_response>/)
  assert.match(text, /\[user\]\nNow compare with London\.$/)
})

test('m365 stream loop detects fenced tool call and finishes with tool_calls', () => {
  const transformed = transformManaged([{ role: 'user', content: 'Weather in Paris?' }])
  const parser = new ToolStreamParser(transformed.plan)
  let sentRole = false
  const feed = (text: string): any[] => {
    const outs = parser.push(text, makeBaseChunk(text), !sentRole)
    if (!outs.length) return []
    sentRole = true
    return outs
  }
  const pieces = [
    'Let me check ',
    '```get_wea',
    'ther\n{"',
    'city": "Par',
    'is"',
    '}\n```',
  ]
  const all: any[] = []
  for (const piece of pieces) all.push(...feed(piece))
  const contentDeltas = all.filter(c => c.choices?.[0]?.delta?.content)
  assert.equal(contentDeltas.map((c) => c.choices[0].delta.content).join(''), 'Let me check ')
  assert.ok(all.some(c => c.choices?.[0]?.delta?.tool_calls?.length))
  assert.equal(parser.hasEmittedToolCall(), true)
  const skeleton = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.6-sol', choices: [{ index: 0, delta: {}, finish_reason: null }] }
  for (const chunk of parser.flush(skeleton)) all.push(chunk)
  const toolDelta = all.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])[0]
  assert.equal(toolDelta.function.name, 'get_weather')
  assert.deepEqual(JSON.parse(toolDelta.function.arguments), { city: 'Paris' })
  assert.equal(parser.hasEmittedToolCall() ? 'tool_calls' : 'stop', 'tool_calls')
})

test('m365 plain answers stream untouched and finish with stop', () => {
  const transformed = transformManaged([{ role: 'user', content: 'Weather in Paris?' }])
  const parser = new ToolStreamParser(transformed.plan)
  let sentRole = false
  let streamedContent = ''
  for (const piece of ['The weather ', 'in Paris is ', 'sunny.']) {
    const outs = parser.push(piece, makeBaseChunk(piece), !sentRole)
    if (!outs.length) continue
    sentRole = true
    for (const c of outs) streamedContent += c.choices[0].delta.content ?? ''
  }
  const flushOuts = parser.flush(makeBaseChunk(''))
  for (const c of flushOuts) streamedContent += c.choices[0].delta.content ?? ''
  assert.equal(streamedContent, 'The weather in Paris is sunny.')
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('m365 non-stream bodies gain tool_calls via applyNonStreamResponse', () => {
  const transformed = transformManaged([{ role: 'user', content: 'Weather in Paris?' }])
  const body = {
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'gpt-5.6-sol',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '```get_weather\n{"city":"Paris"}\n```' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
  const engine = new ToolCallingEngine()
  engine.applyNonStreamResponse(body, transformed.plan)
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.content, null)
  const call = body.choices[0].message.tool_calls[0]
  assert.equal(call.type, 'function')
  assert.equal(call.function.name, 'get_weather')
  assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Paris' })
})
