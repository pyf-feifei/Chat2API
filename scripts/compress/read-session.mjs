/**
 * Read another agent's session export and print its narrative: the messages it
 * sent, the tools it called, and the conclusions it reached.
 *
 * The export stores `entries` as an id-keyed object rather than an array, and
 * the payload is base64 inside a script tag.
 */
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: read-session.mjs <export.html>'); process.exit(1) }

const html = fs.readFileSync(file, 'utf8')
const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)
if (!match) { console.error('no payload found'); process.exit(1) }

const session = JSON.parse(Buffer.from(match[1].trim(), 'base64').toString('utf8'))
const entries = Object.values(session.entries || {})
entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))

const role = (entry) => entry.message?.role || entry.role || entry.type || 'unknown'

function textOf(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        if (part.type === 'text') return part.text || ''
        if (part.type === 'tool_use') return `[tool ${part.name}] ${JSON.stringify(part.input).slice(0, 200)}`
        if (part.type === 'tool_result') {
          const inner = typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
          return `[result] ${String(inner).slice(0, 240)}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const messages = entries.filter((e) => e.message || e.role)
console.log(`session ${session.header?.id || '?'}`)
console.log(`cwd     ${session.header?.cwd || '?'}`)
console.log(`entries ${entries.length}, messages ${messages.length}\n`)

const limit = Number(process.argv[3] || 0)
let shown = 0
for (const entry of messages) {
  const who = role(entry)
  const text = textOf(entry.message || entry)
  if (!text) continue
  shown += 1
  if (limit && shown > limit) continue
  console.log(`--- [${who}] ${entry.timestamp || ''}`)
  console.log(text.slice(0, 1400))
  console.log()
}
if (limit && shown > limit) console.log(`... ${shown - limit} more messages`)
