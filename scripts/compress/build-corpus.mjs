/**
 * Build a Chat Completions corpus from the real captured Codex replay.
 *
 * The measurement is only meaningful on traffic that resembles production, so
 * this slices `codex-replay-payload.json` into requests the proxy actually
 * accepts, rather than synthesizing something convenient.
 *
 * The capture is a Responses-API replay. The interesting shapes to preserve are:
 *   - long histories of tool results (where the text optimizer applies)
 *   - inline base64 screenshots (where image slimming applies)
 *   - multi-turn tool call / result pairs (where the live zone applies)
 *
 * Usage: node scripts/compress/build-corpus.mjs [capture.json] [out.json]
 */

import fs from 'node:fs'

const source = process.argv[2] || 'codex-replay-payload.json'
const out = process.argv[3] || '/tmp/chat2api-corpus.json'

const capture = JSON.parse(fs.readFileSync(source, 'utf8'))
const items = capture.input || capture.messages || []

/**
 * Normalize a Responses content part to the Chat Completions shape.
 *
 * The capture is Responses-API, whose parts are `input_text` / `input_image` /
 * `output_text`. The `/v1/chat/completions` surface rejects those with
 * "Unsupported Qwen AI message content part type: input_text" — a failure that
 * only becomes visible once authentication works, because an unauthenticated
 * request is refused at the token refresh before the body is validated.
 */
function normalizePart(part) {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return null
  const type = part.type
  if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') {
    return { type: 'text', text: part.text ?? part.output_text ?? '' }
  }
  if (type === 'input_image' || type === 'image_url' || type === 'image') {
    const url = part.image_url?.url ?? part.image_url ?? part.url
    if (typeof url !== 'string' || !url) return null
    return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } }
  }
  if (type === 'input_file' || type === 'file') {
    const url = part.file_url?.url ?? part.file_data ?? part.file_id
    if (typeof url === 'string' && url) {
      return { type: 'file', file: { file_id: url }, ...(part.filename ? { filename: part.filename } : {}) }
    }
    return null
  }
  return null
}

function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  const parts = content.map(normalizePart).filter(Boolean)
  return parts.length > 0 ? parts : content
}

/** Convert a Responses `function_call_output` item into a tool result message. */
function toMessages(limit) {
  const messages = [{ role: 'system', content: 'You are a coding agent.' }]
  for (const item of items.slice(0, limit)) {
    const type = item.role || item.type
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${messages.length}`,
          type: 'function',
          function: { name: item.name || 'exec', arguments: item.arguments || '{}' },
        }],
      })
      continue
    }
    if (type === 'function_call_output') {
      const output = item.output
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || `call_${messages.length}`,
        content: Array.isArray(output)
          ? output.map(normalizePart).filter(Boolean)
          : typeof output === 'string'
            ? output
            : JSON.stringify(output ?? ''),
      })
      continue
    }
    if (type === 'assistant' || type === 'user') {
      messages.push({ role: type, content: normalizeContent(item.content ?? '') })
    }
  }
  return messages
}

const requests = []

// Slices of increasing length, so the corpus spans the short-request and
// long-history ends of real traffic. A single 435-item request would only
// measure the extreme.
for (const limit of [20, 60, 120, 240, 435]) {
  const messages = toMessages(limit)
  if (messages.length < 4) continue
  requests.push({ model: 'Qwen3.8-Max', messages })
}

// A dedicated image request, because Responses items carry images inside
// `function_call_output` output and the generic slices may not keep enough of
// them at a readable length.
const imageItems = items.filter((item) => {
  const type = item.role || item.type
  if (type !== 'function_call_output') return false
  const output = item.output
  return Array.isArray(output)
    && output.some((part) => part && part.image_url && typeof part.image_url.url === 'string')
})
if (imageItems.length >= 2) {
  const messages = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Here is the prototype and the current render.' },
  ]
  imageItems.slice(0, 3).forEach((item, index) => {
    messages.push({ role: 'user', content: [{ type: 'text', text: `screenshot ${index}` }] })
    messages.push({
      role: 'tool',
      tool_call_id: `call_img_${index}`,
      content: (item.output || []).map(normalizePart).filter(Boolean),
    })
  })
  messages.push({ role: 'user', content: 'Make the render match the prototype.' })
  requests.push({ model: 'Qwen3.8-Max', messages })
}

fs.writeFileSync(out, JSON.stringify(requests, null, 0))

let totalMessages = 0
let totalChars = 0
for (const request of requests) {
  totalMessages += request.messages.length
  totalChars += JSON.stringify(request.messages).length
}
console.log(`wrote ${out}`)
console.log(`  requests     : ${requests.length}`)
console.log(`  messages     : ${totalMessages}`)
console.log(`  payload chars: ${totalChars.toLocaleString()}`)
console.log(`  sizes        : ${requests.map((r) => r.messages.length).join(', ')}`)
