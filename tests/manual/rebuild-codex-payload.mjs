#!/usr/bin/env node
// Rebuild a real codex Responses request from a rollout .jsonl transcript.
// Translates response_item records back into codex-style input[] items and
// prints a request body that reproduces the sticky-chain continuation path.
import { readFileSync, writeFileSync } from 'node:fs'

const sessionFile = process.argv[2]
const outFile = process.argv[3] || 'codex-replay-payload.json'
const tail = Number(process.argv[4] || 0) // keep only last N items if >0

const lines = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean)

const input = []
let instructions
for (const line of lines) {
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  if (rec.type !== 'response_item') continue
  const p = rec.payload
  if (!p || typeof p !== 'object') continue

  if (p.type === 'message') {
    const role = p.role
    const text = (p.content || []).map(c => c.text ?? c.input_text ?? c.output_text ?? '').join('\n')
    if (role === 'developer' || role === 'system') {
      // developer/system messages become instructions for codex
      instructions = instructions === undefined ? text : instructions + '\n\n' + text
      continue
    }
    const contentType = role === 'assistant' ? 'output_text' : 'input_text'
    input.push({
      type: 'message',
      role,
      content: (p.content || []).map(c => {
        if (c.type === 'input_image' || c.image_url) {
          return { type: 'input_image', image_url: c.image_url }
        }
        return {
          type: c.type === 'output_text' ? 'output_text' : contentType,
          text: c.text ?? '',
        }
      }),
    })
  } else if (p.type === 'function_call') {
    input.push({
      type: 'function_call',
      call_id: p.call_id,
      name: p.name,
      arguments: p.arguments,
    })
  } else if (p.type === 'function_call_output') {
    input.push({
      type: 'function_call_output',
      call_id: p.call_id,
      output: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
    })
  }
  // reasoning items are intentionally dropped — codex does not echo them back
}

const slice = tail > 0 && input.length > tail ? input.slice(-tail) : input
const body = {
  model: 'Qwen3.8-Max',
  instructions,
  input: slice,
  tools: [{
    type: 'function',
    name: 'exec_command',
    description: 'Run a shell command in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to run' },
        workdir: { type: 'string' },
        yield_time_ms: { type: 'number' },
        max_output_tokens: { type: 'number' },
      },
      required: ['cmd'],
    },
  }],
  tool_choice: 'auto',
  reasoning: { effort: 'high', summary: 'auto' },
  store: false,
  stream: true,
}

writeFileSync(outFile, JSON.stringify(body))
console.log('input items:', slice.length)
console.log('instructions chars:', instructions?.length ?? 0)
console.log('first item types:', slice.slice(0, 5).map(i => i.type + '/' + (i.role ?? i.name ?? '')))
console.log('last item types:', slice.slice(-5).map(i => i.type + '/' + (i.role ?? i.name ?? '')))
console.log('written:', outFile, 'bytes:', JSON.stringify(body).length)
