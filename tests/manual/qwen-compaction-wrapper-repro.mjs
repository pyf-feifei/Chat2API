#!/usr/bin/env node
// End-to-end reproducer: send a compaction-style request (many tool results)
// through the local proxy to the real qwen-ai upstream and record the exact
// outcome. Asserts the observed status/errorCode instead of inferring from logs.
import assert from 'node:assert/strict'

const baseUrl = process.env.REPRO_BASE_URL || 'http://127.0.0.1:8082'
const apiKey = process.env.REPRO_API_KEY || ''
const model = process.env.REPRO_MODEL || 'Qwen3.8-Max'
const toolResultCount = Number(process.env.REPRO_TOOL_RESULTS || 30)
const resultChars = Number(process.env.REPRO_RESULT_CHARS || 2000)
const timeoutMs = Number(process.env.REPRO_TIMEOUT_MS || 600000)

function toolResultText(index) {
  const lines = [
    `TOOL_RESULT_${String(index).padStart(3, '0')}: build completed with warnings`,
    `path=C:/workspace/module-${index}/src/app.ts status=modified`,
    `warning=unused import 'render' in src/app.ts:${10 + index}`,
    `pending=step-${index + 1} requires review before merge`,
  ]
  const fact = lines.join('\n')
  const repeats = Math.ceil(Math.max(1, resultChars) / (fact.length + 1))
  return `${fact}\n${fact}\n`.repeat(repeats).slice(0, resultChars)
}

function buildMessages() {
  const messages = [
    { role: 'system', content: 'You are a coding agent. Follow the active instruction exactly.' },
  ]
  for (let round = 0; round < toolResultCount; round += 1) {
    messages.push({ role: 'user', content: `Run the build for module-${round}.` })
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call_repro_${round}`,
        type: 'function',
        function: { name: 'exec_command', arguments: JSON.stringify({ cmd: `build module-${round}` }) },
      }],
    })
    messages.push({ role: 'tool', tool_call_id: `call_repro_${round}`, content: toolResultText(round) })
  }
  messages.push({
    role: 'user',
    content: [
      'CRITICAL: Respond with TEXT ONLY.',
      'Do NOT call or use any tools.',
      'Summarize the complete conversation context and history for continuation.',
      'Preserve decisions, constraints, identifiers, completed work, and pending work.',
      'Return only the summary text.',
    ].join('\n'),
  })
  return messages
}

const body = {
  model,
  stream: true,
  store: false,
  messages: buildMessages(),
  tools: [{
    type: 'function',
    function: {
      name: 'exec_command',
      description: 'Run a shell command in the workspace.',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    },
  }],
  tool_choice: 'auto',
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(new Error(`repro exceeded ${timeoutMs}ms`)), timeoutMs)
const startedAt = Date.now()
const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  },
  body: JSON.stringify(body),
  signal: controller.signal,
})
clearTimeout(timer)

const headersMs = Date.now() - startedAt
console.log(JSON.stringify({ httpStatus: response.status, headersMs }))

if (!response.ok) {
  const text = await response.text()
  console.log('error_body:', text.slice(0, 2000))
  process.exit(1)
}

assert.ok(response.body, 'streaming body missing')
const decoder = new TextDecoder()
let pending = ''
let content = ''
let errorEvent = null
let done = false
let chunkCount = 0
for await (const chunk of response.body) {
  pending += decoder.decode(chunk, { stream: true })
  const frames = pending.split(/\r?\n\r?\n/)
  pending = frames.pop() || ''
  for (const frame of frames) {
    const dataLines = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart())
    const raw = dataLines.join('\n')
    if (!raw || raw === '[DONE]') { if (raw === '[DONE]') done = true; continue }
    let data
    try { data = JSON.parse(raw) } catch { continue }
    chunkCount += 1
    if (data.error) errorEvent = data.error
    const delta = data.choices?.[0]?.delta
    if (typeof delta?.content === 'string') content += delta.content
  }
}

const outcome = {
  elapsedMs: Date.now() - startedAt,
  chunkCount,
  terminalDone: done,
  errorEvent: errorEvent ? String(errorEvent.code ?? errorEvent.message ?? 'unknown') : null,
  summaryChars: content.length,
  contentPreview: content.slice(0, 300),
  leakedWrapperTags: /<\|CHAT2API\|tool_result|<tool_result|<tool_response|<\/?(?:function_results|tool_response)>/i.test(content),
}
console.log(JSON.stringify(outcome, null, 2))
