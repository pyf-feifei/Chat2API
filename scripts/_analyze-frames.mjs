import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
let content = ''
let args = ''
let fragCount = 0
let parsedOk = 0
for (const line of lines) {
  const m = line.match(/Raw stream data: data: (.*$)/)
  if (!m) continue
  const raw = m[1]
  try {
    const o = JSON.parse(raw)
    const d = o.choices?.[0]?.delta || {}
    if (typeof d.content === 'string') content += d.content
    if (d.function_call && typeof d.function_call.arguments === 'string') {
      args += d.function_call.arguments
      fragCount += 1
      parsedOk += 1
    }
  } catch {
    // docker-captured line truncated mid-JSON: salvage the args fragment
    const am = raw.match(/"function_call":\s*\{"name":\s*"[^"]*",\s*"arguments":\s*"((?:[^"\\]|\\.)*)/)
    if (am) {
      try { args += JSON.parse('"' + am[1] + '"') } catch { args += am[1] }
      fragCount += 1
    } else if (raw.includes('"function_call"')) {
      fragCount += 1
    }
  }
}
console.log('content len:', content.length, '| fc fragments:', fragCount, `(parsed ${parsedOk})`, '| args len:', args.length)
try {
  const p = JSON.parse(args)
  console.log('ARGS JSON VALID, cmd head:', JSON.stringify(String(p.cmd || '').slice(0, 150)))
} catch (e) {
  console.log('ARGS INVALID (tail):', JSON.stringify(args.slice(-200)))
}
console.log('=== content head 200 ===')
console.log(JSON.stringify(content.slice(0, 200)))
console.log('=== content tail 200 ===')
console.log(JSON.stringify(content.slice(-200)))
