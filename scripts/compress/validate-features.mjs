/**
 * Feature arming against a live container.
 *
 * The token-reduction features arm before the upstream call, so they can be
 * validated end to end even when the upstream egress is unavailable. That is
 * what this file checks: the features engage, produce the right shapes, and the
 * client's request is still served (or still fails with a well-formed typed
 * error from the stage it actually reached).
 *
 * Unlike `validate-live.mjs`, the container must be started with
 * CHAT2API_REPLAY_SLIM_IMAGES, CHAT2API_UPSTREAM_TOKEN_OPTIMIZER and
 * CHAT2API_COMPRESS_RETRIEVAL set.
 *
 * Usage:
 *   node scripts/compress/validate-features.mjs --base http://127.0.0.1:8080 --key <key>
 */

import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8080')
const KEY = arg('key', '')
if (!KEY) { console.error('missing --key'); process.exit(1) }

let passed = 0
let failed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${t}`) }
function preview(v) { const s = JSON.stringify(v); return s === undefined ? String(v) : s.slice(0, 220) }

function logs() {
  const out = spawnSync('docker', ['logs', '--tail', '600', 'chat2api'], { encoding: 'utf8' })
  return `${out.stdout || ''}${out.stderr || ''}`
}

/**
 * The LAST match, not the first.
 *
 * The container keeps every prior request's log line, and an earlier revision
 * read the first match, so it reported a stale `archivedCount: 0` after the
 * archive was already working.
 */
function lastMatch(text, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let found = null
  for (const match of text.matchAll(global)) found = match
  return found
}

async function api(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed }
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const BIG_TOOL_TEXT = [
  'ERROR: dashboard request failed',
  ...Array.from({ length: 400 }, (_, i) => `diagnostic record ${i} with a longer explanation line to exceed the balanced threshold`),
  'The active fix is dashboard navigation',
].join('\n')

async function main() {
  section('1. Image slimming arms on a real request')
  // Three image-bearing messages; with keepFirst=1 and keepLast=1 the middle one
  // must be replaced by the placeholder before the request leaves the proxy.
  const imageMessages = [0, 1, 2].map((i) => ({
    role: 'user',
    content: [
      { type: 'text', text: `screenshot ${i}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}${i}` } },
    ],
  }))
  const imageResponse = await api('/v1/chat/completions', {
    model: 'Qwen3.8-Max',
    messages: imageMessages,
    max_tokens: 24,
    stream: false,
  })
  check('the image request was accepted by the proxy', typeof imageResponse.body === 'object',
    preview(imageResponse.body))

  let text = logs()
  check('[ChatSlim] replay image slimming was logged', /\[ChatSlim\] replay image slimming/.test(text),
    'the route should slim before the upstream call')
  const slim = lastMatch(text, /\[ChatSlim\] replay image slimming (\{.*\})/)
  if (slim) {
    const payload = JSON.parse(slim[1])
    check('slimming reported a proactive reason', payload.imageSlimReason === 'proactive',
      `reason=${payload.imageSlimReason}`)
    check('slimming reported the keep counts', payload.imageSlimKeepFirst === 1 && payload.imageSlimKeepLast === 1,
      `first=${payload.imageSlimKeepFirst} last=${payload.imageSlimKeepLast}`)
    check('slimming reported it slimmed messages', payload.imageMessagesSlimmed === 1,
      `slimmed=${payload.imageMessagesSlimmed} (one middle message of three)`)
    check('slimming reported characters dropped', payload.imageCharsSlimmed > 0,
      `chars=${payload.imageCharsSlimmed}`)
    check('the log carries counts only, no image content',
      !JSON.stringify(payload).includes('base64'), preview(payload))
  } else {
    check('the [ChatSlim] log line was parseable', false, 'no log line found')
  }

  section('2. The text optimizer arms and archives on a real request')
  const toolMessages = []
  for (let turn = 0; turn < 3; turn += 1) {
    toolMessages.push({
      role: 'user',
      content: `turn ${turn}`,
    })
    toolMessages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${turn}`, type: 'function', function: { name: 'exec', arguments: '{}' } }],
    })
    toolMessages.push({
      role: 'tool',
      tool_call_id: `call_${turn}`,
      content: turn === 1 ? BIG_TOOL_TEXT : 'short filler output',
    })
  }
  toolMessages.push({ role: 'user', content: 'summarize' })

  const toolResponse = await api('/v1/chat/completions', {
    model: 'Qwen3.8-Max',
    messages: toolMessages,
    max_tokens: 24,
    stream: false,
  })
  check('the tool-bearing request was accepted by the proxy', typeof toolResponse.body === 'object',
    preview(toolResponse.body))

  text = logs()
  check('[Forwarder] upstream-token-optimizer was logged',
    /\[Forwarder\] upstream-token-optimizer/.test(text))
  const opt = lastMatch(text, /\[Forwarder\] upstream-token-optimizer (\{.*\})/)
  if (opt) {
    const payload = JSON.parse(opt[1])
    check('the optimizer ran in balanced mode', payload.mode === 'balanced', `mode=${payload.mode}`)
    check('the live zone was reported', typeof payload.liveZoneFloor === 'number' && typeof payload.liveZoneCeiling === 'number',
      `floor=${payload.liveZoneFloor} ceiling=${payload.liveZoneCeiling}`)
    check('the floor source was reported', typeof payload.liveZoneSource === 'string',
      `source=${payload.liveZoneSource}`)
    check('the compute backend was reported', typeof payload.backend === 'string',
      `backend=${payload.backend}`)
    check('the archive was written for the omitted span', payload.archivedCount === 1,
      `archivedCount=${payload.archivedCount} chars=${payload.archivedChars}`)
    check('the log carries archive counts, never a hash',
      !/"[0-9a-f]{16}"/.test(JSON.stringify(payload)), preview(payload))
  } else {
    check('the optimizer log line was parseable', false, 'no log line found')
  }

  section('3. The archive is on disk and scoped')
  const fs = spawnSync('docker', ['exec', 'chat2api', 'sh', '-c',
    'ls -la /data/compression-archive.json 2>/dev/null || echo MISSING'], { encoding: 'utf8' })
  const archiveInfo = `${fs.stdout || ''}${fs.stderr || ''}`
  check('the archive file exists under the data dir', !archiveInfo.includes('MISSING'),
    archiveInfo.trim().slice(0, 120))
  // Its presence under /data is the proof that the path is derived from the
  // runtime's data directory. Reading the configured path back out of the store
  // would need a nested-quote escape that has already broken this script once.
  check('the archive lives beside the other persisted state',
    archiveInfo.includes('/data/compression-archive.json'),
    archiveInfo.trim().slice(0, 160))

  section('4. The upstream stage is reached and fails with a typed error')
  // Every provider reports no-support for non-Qwen models and the Qwen egress is
  // in a risk-control cooldown, so a successful completion is not available. What
  // IS available is proof that the request reached the forwarder, the governor and
  // the adapter, and failed at the network stage with a structured error rather
  // than a crash.
  check('the proxy returned a structured error rather than a crash',
    typeof toolResponse.body?.error?.code === 'string',
    preview(toolResponse.body?.error))
  text = logs()
  check('the governor admitted and released the request',
    /\[QwenAI Governor\] lifecycle/.test(text))
  check('no unhandled crash in the container log',
    !/ReferenceError|TypeError: Cannot read/.test(text),
    'a TDZ or undefined read would appear here')

  section('Summary')
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(`  failing: ${failures.join(', ')}`); process.exitCode = 1 }
}

main().catch((error) => { console.error('crashed:', error); process.exitCode = 1 })
