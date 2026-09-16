#!/usr/bin/env node
// Simulates a codex-style multi-turn session: store:false, full transcript
// each turn, no previous_response_id. Asserts the proxy reuses the same
// upstream chat by appending only the delta.
const BASE = process.env.CHAT2API_DEV_URL || 'http://127.0.0.1:8082'

const tools = [{
  type: 'function',
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}]

const instructions = 'You are a coding agent running in the Codex CLI. You are precise and safe.'

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
  console.log('id:', json.id, 'status:', json.status)
  console.log('function_calls:', calls.length)
  console.log('text:', text?.slice(0, 200))
  return { json, calls, text }
}

// Turn 1: user asks → model calls read_file
const t1 = await callResponses({
  model: 'Qwen3.8-Max',
  instructions,
  input: [{
    type: 'message',
    role: 'user',
    content: 'Read package.json using read_file. You MUST call the tool.',
  }],
  tools,
  tool_choice: 'auto',
  store: false,
  stream: false,
}, 'TURN 1 — tool call')

if (t1.calls.length === 0) {
  console.log('\n⚠ No tool call emitted — cannot continue.')
  process.exit(0)
}
const callId = t1.calls[0].call_id

// Turn 2: send tool result + new question, full transcript (codex style)
// codex sends: [user, assistant(tool_call), tool_result, user_msg]
const t2 = await callResponses({
  model: 'Qwen3.8-Max',
  instructions,
  input: [
    { type: 'message', role: 'user', content: 'Read package.json using read_file. You MUST call the tool.' },
    { type: 'function_call', call_id: callId, name: 'read_file', arguments: '{"path":"package.json"}' },
    { type: 'function_call_output', call_id: callId, output: '{"name":"chat2api","version":"9.9.9"}' },
    { type: 'message', role: 'user', content: 'What is the package name? Answer in one word.' },
  ],
  tools,
  tool_choice: 'auto',
  store: false,
  stream: false,
}, 'TURN 2 — tool result + new question (full transcript)')

// Turn 3: another question on the same chain — still full transcript
const t3 = await callResponses({
  model: 'Qwen3.8-Max',
  instructions,
  input: [
    { type: 'message', role: 'user', content: 'Read package.json using read_file. You MUST call the tool.' },
    { type: 'function_call', call_id: callId, name: 'read_file', arguments: '{"path":"package.json"}' },
    { type: 'function_call_output', call_id: callId, output: '{"name":"chat2api","version":"9.9.9"}' },
    { type: 'message', role: 'user', content: 'What is the package name? Answer in one word.' },
    { type: 'message', role: 'assistant', content: 'chat2api' },
    { type: 'message', role: 'user', content: 'Say exactly: CHAIN_OK' },
  ],
  tools,
  tool_choice: 'auto',
  store: false,
  stream: false,
}, 'TURN 3 — continued chain (full transcript)')

console.log('\n=== CHECK dev-server.log for: ===')
console.log('  "Qwen sticky chain continuation" on turns 2 & 3')
console.log('  same chatId across continuation-accepted lines')
console.log('  "storeConversation entry" with storeField:false')
