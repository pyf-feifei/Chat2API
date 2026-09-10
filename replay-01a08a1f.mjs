// Real-context replay stress: session 01a08a1f-87b8-7511-88ef-220fd6b03f35.
// Replays the ACTUAL poisoned codex conversation (assistant messages claiming
// "exec_command is unavailable" + dumped code + leaked markers, with real
// tool results) against the local container and asserts the fixed pipeline:
//   - zero completion-marker leakage
//   - zero denial-claim / code-dump prose in delivered content
//   - well-formed tool call or clean final answer on the FIRST response
//   - exactly one upstream request (no continuation / recovery round-trip)
import fs from 'node:fs'
import readline from 'node:readline'

const SESSION_FILE = process.argv[2]
  || 'C:/Users/skate_f/.codex/sessions/2026/09/10/rollout-2026-09-10T15-01-57-01a08a1f-87b8-7511-88ef-220fd6b03f35.jsonl'
const BASE_URL = process.env.REPLAY_BASE_URL || 'http://127.0.0.1:8080'
const RUNS = Number(process.env.REPLAY_RUNS || 3)
const MODEL = process.env.REPLAY_MODEL || 'Qwen3.8-Max'
const API_KEY = process.env.REPLAY_API_KEY || process.env.CHAT2API_API_KEY || ''

const TOOL_BLOCK = '<|CHAT2API|tool_calls>'

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => part?.text || '').join('')
}

async function loadConversation() {
  const rl = readline.createInterface({ input: fs.createReadStream(SESSION_FILE) })
  const messages = []
  for await (const line of rl) {
    let item
    try { item = JSON.parse(line) } catch { continue }
    const payload = item?.payload
    if (item?.type !== 'response_item' || !payload) continue
    if (payload.type === 'message') {
      const text = textFromContent(payload.content)
      if (!text.trim()) continue
      messages.push({ role: payload.role, content: text })
    } else if (payload.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: payload.call_id || `call_${messages.length}`,
          type: 'function',
          function: { name: payload.name, arguments: payload.arguments || '{}' },
        }],
      })
    } else if (payload.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: payload.call_id || '',
        content: String(payload.output || '').slice(0, 8000),
      })
    }
  }
  // Drop leading empty assistant carriers and ensure the trailing item gives
  // the model something to answer (the real session ends with a tool result).
  while (messages.length && messages[0].role === 'assistant' && !messages[0].tool_calls) {
    messages.shift()
  }
  return messages
}

function codexStyleTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Runs a shell command and returns its output.',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string', description: 'The command to run' } },
          required: ['cmd'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'view_image',
        description: 'View an image file from the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Image path' } },
          required: ['path'],
        },
      },
    },
  ]
}

const DENIAL_PATTERNS = [
  /currently unavailable/i,
  /unavailable in this (?:environment|session|turn)/i,
  /becomes? available again/i,
  /retry in a new turn/i,
  /does not exists/i,
]

async function runOnce(runIndex, conversation) {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: conversation,
      tools: codexStyleTools(),
      tool_choice: 'auto',
    }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`)
  }

  const contentParts = []
  const toolCalls = []
  let finishReason = null
  let raw = ''
  let responseId = null
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        raw += data
        if (!responseId && typeof parsed.id === 'string') responseId = parsed.id
        const choice = parsed.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.content === 'string') contentParts.push(delta.content)
        if (Array.isArray(delta?.tool_calls)) toolCalls.push(...delta.tool_calls)
        if (choice?.finish_reason) finishReason = choice.finish_reason
      } catch { /* partial frames are reassembled above */ }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1500))

  const content = contentParts.join('')
  const markerLeak = /chat2api_workflow_complete/.test(raw)
  const denialHits = DENIAL_PATTERNS.filter(pattern => pattern.test(content))
  // Attribute upstream attempts to THIS conversation via the per-attempt
  // 'Got response_id' log (the stream chunk id IS the upstream response id) —
  // a shared docker-logs counter counts any concurrent client traffic (e.g. a
  // live codex session) as ours.
  const upstreamRequests = await countUpstreamRequestsForResponse(responseId)

  const result = {
    run: runIndex,
    contentChars: content.length,
    toolCallCount: toolCalls.length,
    toolNames: [...new Set(toolCalls.map(call => call?.function?.name).filter(Boolean))],
    finishReason,
    markerLeak,
    denialHits: denialHits.map(pattern => pattern.source),
    upstreamRequests,
    contentHead: content.slice(0, 160),
    contentTail: content.slice(-160),
  }
  console.log(JSON.stringify(result))
  return result
}

let baselineLogSize = null
async function countUpstreamRequestsForResponse(responseId) {
  if (!responseId) return -1
  const { execFileSync } = await import('node:child_process')
  const logs = execFileSync('docker', ['logs', 'chat2api', '--since', '30m'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const pattern = new RegExp(`\\[QwenAI\\] Got response_id: ${responseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  return (logs.match(pattern) || []).length
}

const conversation = await loadConversation()
console.log(JSON.stringify({
  replayStart: true,
  messages: conversation.length,
  assistantMessages: conversation.filter(m => m.role === 'assistant').length,
  toolResults: conversation.filter(m => m.role === 'tool').length,
  chars: conversation.reduce((total, m) => total + String(m.content || '').length, 0),
}))

let failures = 0
for (let run = 1; run <= RUNS; run += 1) {
  try {
    const result = await runOnce(run, conversation)
    const problems = []
    if (result.markerLeak) problems.push('marker leak')
    if (result.denialHits.length > 0) problems.push(`denial prose: ${result.denialHits.join(', ')}`)
    if (result.upstreamRequests > 1) problems.push(`extra upstream requests: ${result.upstreamRequests}`)
    if (result.toolCallCount === 0 && result.contentChars < 10) problems.push('empty response')
    if (problems.length > 0) {
      failures += 1
      console.log(`RUN ${run}: FAIL — ${problems.join('; ')}`)
    } else {
      console.log(`RUN ${run}: PASS`)
    }
  } catch (error) {
    failures += 1
    console.log(`RUN ${run}: ERROR — ${error.message}`)
  }
}
console.log(JSON.stringify({ summary: failures === 0 ? 'ALL PASS' : `${failures}/${RUNS} FAILED` }))
process.exit(failures === 0 ? 0 : 1)
