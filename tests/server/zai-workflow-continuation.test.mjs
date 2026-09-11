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
  // The model announced an action → the recovery nudge demands the call.
  assert.equal(verdict.requireManagedToolCall, true)
  assert.equal(verdict.reason, 'progress_style_answer_without_tool_call')
})

test('classifyZaiManagedAnswer flags first-turn "我会" promise prose (2026-09-11 continuation-branch escape)', () => {
  // Observed live: the progress-style continuation round-trip itself came
  // back with "我会先打开…" — an intent opener gap that let the recovered
  // branch stall the turn a second time.
  const verdict = classifyZaiManagedAnswer('我会先打开 `prompt.md` 和项目文件清单，确认参考图与当前 3D 场景的对应关系。', createPlan())
  assert.equal(verdict.continuation, true)
  assert.equal(verdict.requireManagedToolCall, true)
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

// ---------------------------------------------------------------------------
// Rejected tool-call blocks (2026-09-11 GLM-5.3-Flash incident)
//
// The model followed the taught managed_xml protocol but the block was
// rejected (undeclared tool name / schema-invalid arguments). The stream
// parser drops such blocks silently, so the client only saw the surrounding
// intent prose — and the appended block length defeated the 300-codepoint
// progress-intent cap, so the classifier delivered the promise prose as a
// first-turn auto answer and the client turn stopped with the action lost.
// ---------------------------------------------------------------------------

const INCIDENT_PROSE = '我先在本地 Codex 配置目录里查找这个会话 ID。我先检查本机 Codex 会话存储，并按这个 UUID 精确检索。'

const UNDECLARED_NAME_BLOCK = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="find_file"><|CHAT2API|parameter name="pattern"><![CDATA[01a08a1f-87b8-7511-88ef-220fd6b03f35]]></|CHAT2API|parameter><|CHAT2API|parameter name="path"><![CDATA[C:\Users\skate_f\.codex\sessions]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

const SCHEMA_INVALID_BLOCK = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="shell"><|CHAT2API|parameter name="cwd"><![CDATA[C:\Users\skate_f\.codex]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

test('rejected tool-call block (undeclared name) recovers a first-turn promise answer', () => {
  const verdict = classifyZaiManagedAnswer(INCIDENT_PROSE + UNDECLARED_NAME_BLOCK, createPlan())
  assert.equal(verdict.continuation, true)
  assert.equal(verdict.reason, 'rejected_tool_call_block')
  // A rejected block IS an attempted call → recovery demands the real call.
  assert.equal(verdict.requireManagedToolCall, true)
})

test('rejected tool-call block (schema-invalid arguments) triggers continuation', () => {
  // Valid tool name, missing the required `command` argument: parse pushes
  // the raw match but no tool call. The default createPlan tool schema has no
  // required fields, so this test pins a plan whose schema actually rejects.
  const verdict = classifyZaiManagedAnswer(INCIDENT_PROSE + SCHEMA_INVALID_BLOCK, createPlan({
    tools: [{
      name: 'shell',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      source: 'responses',
    }],
    allowedToolNames: new Set(['shell']),
  }))
  assert.equal(verdict.continuation, true)
  assert.equal(verdict.reason, 'rejected_tool_call_block')
})

test('rejected tool-call block over a live workflow demands the tool call', () => {
  const verdict = classifyZaiManagedAnswer(
    INCIDENT_PROSE + UNDECLARED_NAME_BLOCK,
    createPlan({ hasLiveToolWorkflow: true }),
  )
  assert.equal(verdict.continuation, true)
  assert.equal(verdict.reason, 'rejected_tool_call_block')
  assert.equal(verdict.requireManagedToolCall, true)
})

test('failed tool results keep the relaxed contract over a rejected block', () => {
  // After an explicit failure result the model may explain or retry without a
  // tool call; the classifier must not force a continuation there.
  const verdict = classifyZaiManagedAnswer(
    INCIDENT_PROSE + UNDECLARED_NAME_BLOCK,
    createPlan({ failedToolResultPending: true }),
  )
  assert.equal(verdict.continuation, false)
  assert.equal(verdict.reason, 'failed_tool_result_pending')
})

test('a fenced protocol example in prose is not a rejected tool-call block', () => {
  // stripFencedCodeBlocks removes fenced literals before parsing, so prose
  // that QUOTES the wire format stays a legitimate first-turn answer.
  const fenced = `${INCIDENT_PROSE}\n\n\`\`\`\n${UNDECLARED_NAME_BLOCK}\n\`\`\`\nThe block above shows the required format.`
  const verdict = classifyZaiManagedAnswer(fenced, createPlan())
  assert.equal(verdict.continuation, false)
  assert.equal(verdict.reason, 'first_turn_auto_answer')
})

test('colon-terminated first-turn promise answer triggers continuation (2026-09-11 incident)', () => {
  // Observed live: GLM-5.3-Flash answered a codex first turn with exactly this
  // prose and ended the turn — no opener match, no tool call, no rejected
  // block. The trailing colon promises the command/tool call that never came.
  const verdict = classifyZaiManagedAnswer(
    '可以在本地 Codex 会话存储里找一下，我用这个 UUID 搜文件名和内容：',
    createPlan(),
  )
  assert.equal(verdict.continuation, true)
  // Promised action → recovery demands the concrete tool call.
  assert.equal(verdict.requireManagedToolCall, true)
  assert.equal(verdict.reason, 'colon_terminated_short_answer')
})

test('colon-terminated detection stays structural: ASCII colon, negatives, length cap', () => {  // ASCII colon (phrased to avoid the progress-opener word-list, which runs
  // first — the colon signal must be independent of the opener wording).
  assert.equal(
    classifyZaiManagedAnswer('The session index lives under the codex home, so the fastest check is a filename grep:', createPlan()).reason,
    'colon_terminated_short_answer',
  )
  // A complete declarative sentence without a trailing colon stays deliverable.
  assert.equal(
    classifyZaiManagedAnswer('可以在本地 Codex 会话存储里找一下，我用这个 UUID 搜文件名和内容。', createPlan()).reason,
    'first_turn_auto_answer',
  )
  // A complete answer that merely CONTAINS a colon mid-text stays deliverable.
  assert.equal(
    classifyZaiManagedAnswer('配置如下：\n\n完整步骤是先读取会话索引，然后过滤 thread id。', createPlan()).reason,
    'first_turn_auto_answer',
  )
  // Over the progress-intent length cap the colon signal no longer fires;
  // long answers keep the first-turn auto contract.
  const longColonAnswer = `以下是完整分析：\n${'结论段落。'.repeat(60)}：`
  assert.equal(
    classifyZaiManagedAnswer(longColonAnswer, createPlan()).reason,
    'first_turn_auto_answer',
  )
})

test('trailing fenced JSON matching declared tool parameters triggers continuation (2026-09-11 incident)', () => {
  // Observed live: GLM-5.3-Flash wrote the next unified_exec call's argument
  // object as a fenced JSON example instead of the taught managed_xml wire
  // format; the turn completed, the command never ran. The key match is
  // derived from the declared schemas, never hardcoded tool names.
  const unifiedExecPlan = createPlan({
    tools: [{
      name: 'unified_exec',
      parameters: { type: 'object', properties: { cmd: { type: 'string' }, yield_time_ms: { type: 'number' } } },
      source: 'responses',
    }],
    allowedToolNames: new Set(['unified_exec']),
  })
  const verdict = classifyZaiManagedAnswer(
    '文件仍被活跃 Codex 进程占用；我用共享读取模式直接解析 JSONL。\n```json\n{"cmd": "Get-Content ...", "yield_time_ms": 30000}\n```',
    unifiedExecPlan,
  )
  assert.equal(verdict.continuation, true)
  // The fenced block IS an attempted call → recovery demands the real call.
  assert.equal(verdict.requireManagedToolCall, true)
  assert.equal(verdict.reason, 'fenced_tool_argument_json')

  // A fenced JSON whose keys are NOT declared parameters is documentation and
  // stays deliverable.
  assert.equal(
    classifyZaiManagedAnswer(
      '配置格式如下：\n```json\n{"host": "localhost", "port": 8080}\n```',
      unifiedExecPlan,
    ).reason,
    'first_turn_auto_answer',
  )
  // A fence that is not the trailing content (prose after it) stays deliverable.
  assert.equal(
    classifyZaiManagedAnswer(
      '示例：\n```json\n{"cmd": "ls"}\n```\n以上就是完整命令。',
      unifiedExecPlan,
    ).reason,
    'first_turn_auto_answer',
  )
  // A long explanation around the example keeps the documentation contract.
  const longExplanation = '下面详细解释每个参数的语义和取值范围。'.repeat(40)
  assert.equal(
    classifyZaiManagedAnswer(
      `${longExplanation}\n\`\`\`json\n{"cmd": "ls", "yield_time_ms": 1000}\n\`\`\``,
      unifiedExecPlan,
    ).reason,
    'first_turn_auto_answer',
  )
  // A fenced non-JSON body (e.g. a quoted protocol example) never matches.
  assert.equal(
    classifyZaiManagedAnswer(
      `${INCIDENT_PROSE}\n\`\`\`\n${UNDECLARED_NAME_BLOCK}\n\`\`\``,
      createPlan(),
    ).reason,
    'first_turn_auto_answer',
  )
})
