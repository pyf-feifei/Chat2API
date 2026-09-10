import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
const { classifyZaiManagedAnswer, ZaiStreamHandler } = await vite.ssrLoadModule('/src/main/proxy/adapters/zai.ts')

after(async () => {
  await vite?.close()
})

function createPlan(overrides = {}) {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'codex_responses',
    providerId: 'zai',
    tools: [{ name: 'shell', parameters: { type: 'object', properties: {} }, source: 'responses' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['shell']),
    workflowContinuation: false,
    failedToolResultPending: false,
    hasLiveToolWorkflow: false,
    diagnostics: { requestId: 'test-req' },
    ...overrides,
  }
}

function createUpstreamSse(events) {
  const stream = new Readable({ read() {} })
  for (const event of events) {
    stream.push(`data: ${JSON.stringify({ type: 'chat:completion', data: event })}\n\n`)
  }
  stream.push('data: [DONE]\n\n')
  // `close` must fire so the handler finalizes; Readable emits `end`/`close`
  // once destroyed.
  stream.destroy = stream.destroy.bind(stream)
  process.nextTick(() => {
    stream.push(null)
  })
  return stream
}

async function collect(stream, timeoutMs = 3000) {
  const chunks = []
  stream.on('data', (c) => chunks.push(c.toString()))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('collect timeout')), timeoutMs)
    stream.on('end', () => { clearTimeout(timer); resolve() })
    stream.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
  return chunks.join('')
}

function parseClientChunks(raw) {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)))
}

test('classifyZaiManagedAnswer flags progress-style prose without a tool call', () => {
  const verdict = classifyZaiManagedAnswer('我来查看 Codex 的 skill 注册目录和配置。', createPlan())
  assert.equal(verdict.continuation, true)
  assert.equal(verdict.requireManagedToolCall, false)
  assert.equal(verdict.reason, 'progress_style_answer_without_tool_call')
})

test('classifyZaiManagedAnswer passes through a long first-turn auto answer', () => {
  const longAnswer = '这里是完整的最终回答。'.repeat(60)
  const verdict = classifyZaiManagedAnswer(longAnswer, createPlan())
  assert.equal(verdict.continuation, false)
  assert.equal(verdict.reason, 'first_turn_auto_answer')
})

test('classifyZaiManagedAnswer demands a tool call over a live workflow', () => {
  const verdict = classifyZaiManagedAnswer('我来查看 Codex 的 skill 注册目录和配置。', createPlan({ hasLiveToolWorkflow: true }))
  assert.equal(verdict.continuation, true)
  assert.equal(verdict.requireManagedToolCall, true)
  assert.equal(verdict.reason, 'progress_style_answer_over_live_workflow')
})

test('stream handler recovers a dangling progress answer via same-chat continuation', async () => {
  const plan = createPlan()
  const assistantMessageId = 'assistant-msg-1'

  const upstream1 = createUpstreamSse([
    { id: assistantMessageId, role: 'assistant' },
    { phase: 'answer', delta_content: '我来查看 Codex 的 skill 注册目录和配置。' },
    { phase: 'done', done: true, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ])

  const upstream2 = createUpstreamSse([
    { id: 'assistant-msg-2', role: 'assistant' },
    { phase: 'answer', delta_content: `${'这里是完整的最终回答。'.repeat(60)}` },
    { phase: 'done', done: true, usage: { prompt_tokens: 20, completion_tokens: 50, total_tokens: 70 } },
  ])

  const continuationCalls = []
  const handler = new ZaiStreamHandler('GLM-5.3-Flash', undefined, plan)
  handler.setChatId('chat-1')
  handler.setContinuation({
    activeChatId: () => (continuationCalls.length > 0 ? 'chat-2' : 'chat-1'),
    start: async (verdict, danglingContent, parentMessageId) => {
      continuationCalls.push({ verdict, danglingContent, parentMessageId })
      return { response: { data: upstream2 }, chatId: 'chat-2' }
    },
  })

  const outputPromise = collect(await handler.handleStream(upstream1))
  const raw = await outputPromise
  const chunks = parseClientChunks(raw)

  assert.equal(continuationCalls.length, 1)
  assert.equal(continuationCalls[0].parentMessageId, assistantMessageId)
  assert.equal(continuationCalls[0].verdict.reason, 'progress_style_answer_without_tool_call')
  assert.ok(continuationCalls[0].danglingContent.includes('我来查看'))

  const contents = chunks
    .map((c) => c.choices?.[0]?.delta?.content)
    .filter((c) => typeof c === 'string')
  assert.ok(contents.some((c) => c.includes('我来查看')), 'branch 1 prose must stay visible')
  const combined = contents.join('')
  assert.ok(combined.includes('这里是完整的最终回答'), 'branch 2 answer must be appended')

  const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.ok(finishChunk, 'a finish_reason chunk must be delivered')
  assert.equal(finishChunk.choices[0].finish_reason, 'stop')
  assert.deepEqual(
    finishChunk.usage,
    { prompt_tokens: 20, completion_tokens: 50, total_tokens: 70 },
    'final usage must come from the continuation branch',
  )
})

test('stream handler delivers as-is when the continuation budget is spent', async () => {
  const plan = createPlan()

  const upstream1 = createUpstreamSse([
    { id: 'assistant-msg-1', role: 'assistant' },
    { phase: 'answer', delta_content: '我来查看 Codex 的 skill 注册目录和配置。' },
    { phase: 'done', done: true },
  ])

  const continuationCalls = []
  const handler = new ZaiStreamHandler('GLM-5.3-Flash', undefined, plan)
  handler.setChatId('chat-1')
  handler.setContinuation({
    activeChatId: () => 'chat-1',
    start: async (verdict, danglingContent, parentMessageId) => {
      continuationCalls.push({ verdict, danglingContent, parentMessageId })
      return null
    },
  })

  const raw = await collect(await handler.handleStream(upstream1))
  const chunks = parseClientChunks(raw)

  assert.equal(continuationCalls.length, 1)
  const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.ok(finishChunk)
  assert.equal(finishChunk.choices[0].finish_reason, 'stop')
  const combined = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
  assert.ok(combined.includes('我来查看'), 'dangling answer must still be delivered')
})

test('stream handler works without a continuation handle (non-tool / disabled plans)', async () => {
  const plan = createPlan({ shouldParseResponse: false })

  const upstream1 = createUpstreamSse([
    { id: 'assistant-msg-1', role: 'assistant' },
    { phase: 'answer', delta_content: '普通回答，没有工具协议。' },
    { phase: 'done', done: true },
  ])

  const handler = new ZaiStreamHandler('GLM-5.3-Flash', undefined, plan)
  handler.setChatId('chat-1')

  const raw = await collect(await handler.handleStream(upstream1))
  const chunks = parseClientChunks(raw)
  const combined = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
  assert.ok(combined.includes('普通回答'))
  const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.ok(finishChunk)
  assert.equal(finishChunk.choices[0].finish_reason, 'stop')
})

test('idle watchdog ends a silent upstream with a visible notice', async () => {
  process.env.CHAT2API_ZAI_STREAM_IDLE_TIMEOUT_MS = '80'
  try {
    const plan = createPlan()
    const silent = new PassThrough()
    const handler = new ZaiStreamHandler('GLM-5.3-Flash', undefined, plan)
    handler.setChatId('chat-1')

    const rawPromise = collect(await handler.handleStream(silent), 5000)
    // Never push any upstream event; the watchdog must end the stream.
    const raw = await rawPromise
    const chunks = parseClientChunks(raw)
    const combined = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
    assert.ok(combined.includes('idle'), 'a visible stall notice must be delivered')
    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason)
    assert.ok(finishChunk)
    assert.equal(finishChunk.choices[0].finish_reason, 'stop')
  } finally {
    delete process.env.CHAT2API_ZAI_STREAM_IDLE_TIMEOUT_MS
  }
})
