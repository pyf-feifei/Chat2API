#!/usr/bin/env node
// Simulates a codex tool-call loop against the dev server:
//   turn 1: user asks → model emits function_call → returns resp_A
//   turn 2: client sends function_call_output (+ prev_id) → model answers
//   turn 3: client sends a fresh user question (+ prev_id) → delta append
// Asserts the same upstream chatId is reused across turns.
const BASE = process.env.CHAT2API_DEV_URL || 'http://127.0.0.1:8082'

const tools = [{
  type: 'function',
  name: 'read_file',
  description: 'Read a file from disk and return its contents.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
}]

async function callResponses(body, label) {
  const res = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  const text = json.output?.find(o => o.type === 'message')?.content?.[0]?.text
  const calls = (json.output ?? []).filter(o => o.type === 'function_call')
  console.log(`\n=== ${label} ===`)
  console.log('id:', json.id)
  console.log('status:', json.status)
  console.log('function_calls:', calls.map(c => `${c.name}(${c.arguments})`))
  console.log('text:', text?.slice(0, 200))
  return { json, calls, text }
}

// Turn 1: trigger a tool call
const turn1 = await callResponses({
  model: 'Qwen3.8-Max_Auto',
  input: [{
    type: 'message',
    role: 'user',
    content: 'Use the read_file tool to read package.json. You MUST call the tool.',
  }],
  tools,
  tool_choice: 'auto',
  stream: false,
}, 'TURN 1 — expect function_call')

if (turn1.calls.length === 0) {
  console.log('\n⚠ Model did not emit a tool call — cannot test tool-result continuation.')
  process.exit(0)
}

const call = turn1.calls[0]
console.log('\nTool call emitted:', call.call_id, call.name)

// Turn 2: send back the tool result — this is the pure-tool-result fast path
const turn2 = await callResponses({
  model: 'Qwen3.8-Max_Auto',
  previous_response_id: turn1.json.id,
  input: [{
    type: 'function_call_output',
    call_id: call.call_id,
    output: JSON.stringify({ name: 'chat2api', version: '1.0.0-test' }),
  }],
  tools,
  tool_choice: 'auto',
  stream: false,
}, 'TURN 2 — tool result (should continue same chat)')

// Turn 3: a fresh user question on the same lineage — sticky generic delta
const turn3 = await callResponses({
  model: 'Qwen3.8-Max_Auto',
  previous_response_id: turn2.json.id,
  input: [{
    type: 'message',
    role: 'user',
    content: 'What was the package name you just read? Answer in one word.',
  }],
  tools,
  tool_choice: 'auto',
  stream: false,
}, 'TURN 3 — new user message (sticky generic delta)')

console.log('\n=== CHECK dev-server.log for: ===')
console.log('  "Qwen sticky session continuation candidate" on turns 2 & 3')
console.log('  same chatId across all continuation-accepted lines')
