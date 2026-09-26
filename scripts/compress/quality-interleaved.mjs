/**
 * Interleaved quality A/B.
 *
 * The first two attempts ran all tasks with the features off, then started a
 * second container and ran them with the features on. That is confounded: the
 * second arm always runs later, on an account pool the first arm already spent,
 * so the pool's rate state is a second uncontrolled variable. The second attempt
 * produced a headline "-87.5 pp" that was entirely `qwen_ai_risk_circuit_open`
 * and `qwen_ai_content_verdict` — the rate limit, not the model.
 *
 * This driver alternates the container state per task instead, so time order and
 * treatment are no longer aligned. It is slower and it still runs against a
 * shared pool, so the gap between tasks stays wide and every response is kept.
 *
 * Usage:
 *   node scripts/compress/quality-interleaved.mjs --key <k> --arm A --limit 8 --gap 25000
 */

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const KEY = arg('key', '')
const ARM = arg('arm', 'A')
const LIMIT = Number(arg('limit', '8'))
const GAP = Number(arg('gap', '25000'))
const IMAGE = arg('image', 'chat2api-local:latest')
const VOLUME = arg('volume', 'chat2api_chat2api-data')
const MODEL = arg('model', 'Qwen3.8-Max')
if (!KEY) { console.error('missing --key'); process.exit(1) }

const BASE = 'http://127.0.0.1:8080'
const KEYLINE = fs.readFileSync('.env', 'utf8')
  .split('\n').find((l) => /^\s*CHAT2API_STORAGE_ENCRYPTION_KEY=/.test(l))
const ENCRYPTION_KEY = KEYLINE ? KEYLINE.replace(/^[^=]*=/, '').trim() : ''
if (!ENCRYPTION_KEY) { console.error('no encryption key in .env; refusing to run 339 unreadable accounts'); process.exit(1) }

const ON = {
  CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'always',
  CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '1',
  CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '1',
  CHAT2API_REPLAY_SLIM_IMAGES: 'always',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'balanced',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS: '0',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES: '8',
  // The arm B filler is ~3.3k characters. The default 16000 ceiling makes
  // balanced mode correctly decline it, so the treatment never fires and the
  // comparison measures nothing. Lowering the threshold makes the treatment
  // real without inflating the payload.
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MAX_TOOL_TEXT_CHARS: '600',
  CHAT2API_COMPRESS_RETRIEVAL: 'on',
}

const FILLER = [
  'The release notes mention a deprecation in the parser module.',
  'A test fixture was renamed last sprint; the old name no longer resolves.',
  'Someone asked about caching headers last week; the answer was "later".',
  'The changelog has an entry about a typo fix in the README badge.',
  'There was a discussion about log rotation on the staging box.',
  'An issue was filed about a flaky snapshot test; it is still open.',
  'The docs mention running the linter before pushing.',
  'A reviewer asked for a comment explaining the retry constant.',
].join(' ')

const TASKS = {
  // Arm A: no tool messages and no images, so the features are inert. That is
  // deliberate: it is the control arm, and a regression here would mean the
  // features damage a request they never touched.
  A: [
    { id: 'sum', prompt: 'What is 137 + 486? Reply with only the number.', expect: '623' },
    { id: 'reverse', prompt: 'Reverse the string "chat2api". Reply with only the reversed string.', expect: 'ip2tahc' },
    { id: 'json', prompt: 'Reply with only valid JSON, no prose: {"a": [1, 2], "b": "x"}', expect: '"a": [1, 2]' },
    { id: 'count', prompt: 'How many words are in this sentence: the quick brown fox jumps? Reply with only the number.', expect: '6' },
    { id: 'lower', prompt: 'Convert "MiXeD CaSe" to lowercase. Reply with only the lowercase result.', expect: 'mixed case' },
    { id: 'primary', prompt: 'List the three primary colors. Reply with only a comma-separated list.', expect: 'red' },
    { id: 'multiply', prompt: 'What is 24 times 37? Reply with only the number.', expect: '888' },
    { id: 'sort', prompt: 'Sort these ascending and reply with only the result: pear, apple, fig', expect: 'apple' },
    { id: 'subtract', prompt: 'What is 1000 minus 258? Reply with only the number.', expect: '742' },
    { id: 'upper', prompt: 'Convert "proxy" to uppercase. Reply with only the uppercase result.', expect: 'PROXY' },
  ],
  // Arm B, real version. The answer lives inside an OLD TOOL MESSAGE, because
  // that is the only thing `balanced` mode compresses. The first version of this
  // arm put the answer in a plain user turn and contained no tool message at
  // all, so the features were inert and 6/6 on both states proved nothing.
  //
  // The answer tool message must land above the live-zone ceiling, which with the
  // default recentMessages=8 is index < length - 9. Five tool turns put it at
  // index 3 of 13, which is eligible.
  B: [
    { id: 'tool-pin', answer: 'ACCOUNT_PIN=7734', prompt: 'What is the account PIN from the lookup output? Reply with only the 4 digits.', expect: '7734' },
    { id: 'tool-fruit', answer: 'FAVOURITE_FRUIT=kiwi', prompt: 'Which fruit is in the lookup output? Reply with only the word.', expect: 'kiwi' },
    { id: 'tool-room', answer: 'ROOM_NUMBER=4127', prompt: 'Which room is in the lookup output? Reply with only the number.', expect: '4127' },
    { id: 'tool-word', answer: 'PASSCODE=quartzite', prompt: 'What passcode is in the lookup output? Reply with only the word.', expect: 'quartzite' },
    { id: 'tool-code', answer: 'ACCESS_CODE=9058', prompt: 'Which access code is in the lookup output? Reply with only the number.', expect: '9058' },
    { id: 'tool-animal', answer: 'FAVOURITE_ANIMAL=pangolin', prompt: 'Which animal is in the lookup output? Reply with only the animal.', expect: 'pangolin' },
  ],
}[ARM].slice(0, LIMIT)

// Filler long enough that balanced mode must excerpt it rather than pass it
// through, and containing no digits or answer-shaped text.
const TOOL_FILLER = Array.from({ length: 60 }, (_, i) =>
  `diagnostic sample ${i} :: elapsed_ms=${(i * 7) % 90 + 10} :: stage=collect :: note=ok`,
).join(String.fromCharCode(10))

function messagesFor(task) {
  const system = { role: 'system', content: 'Answer exactly as instructed. Be brief.' }
  if (ARM === 'A') return [system, { role: 'user', content: task.prompt }]

  // Five completed tool turns. The first carries the answer; the rest are filler
  // that the optimizer is allowed to excerpt.
  const messages = [system, { role: 'user', content: 'Run the account lookup and report what it returns.' }]
  for (let turn = 0; turn < 5; turn += 1) {
    const body = turn === 0 ? task.answer : TOOL_FILLER
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${turn}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ step: turn }) } }],
    })
    messages.push({ role: 'tool', tool_call_id: `call_${turn}`, content: body })
  }
  messages.push({ role: 'user', content: task.prompt })
  return messages
}

function normalise(value) {
  return String(value || '').toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, '')
}

let currentState = null
function start(state) {
  if (currentState === state) return
  spawnSync('docker', ['rm', '-f', 'chat2api'])
  const cmd = ['run', '-d', '--name', 'chat2api', '-p', '8080:8080',
    '-e', `CHAT2API_STORAGE_ENCRYPTION_KEY=${ENCRYPTION_KEY}`, '-v', `${VOLUME}:/data`]
  if (state === 'on') for (const [k, v] of Object.entries(ON)) cmd.push('-e', `${k}=${v}`)
  cmd.push(IMAGE)
  const r = spawnSync('docker', cmd, { encoding: 'utf8' })
  if (r.status !== 0) { console.error('start failed', r.stderr); process.exit(1) }
  currentState = state
}

async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Whether the optimizer actually rewrote something in the current container. */
function treatmentFired() {
  const out = spawnSync('docker', ['logs', 'chat2api'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const text = (out.stdout || '') + (out.stderr || '')
  const rows = [...text.matchAll(/\[Forwarder\] upstream-token-optimizer (\{.*?\})\s*$/gm)]
    .map((m) => { try { return JSON.parse(m[1]) } catch { return null } })
    .filter(Boolean)
  const last = rows[rows.length - 1]
  return {
    lines: rows.length,
    changedMessageCount: last ? last.changedMessageCount || 0 : 0,
    before: last ? last.before : 0,
    after: last ? last.after : 0,
    archivedChars: last ? last.archivedChars || 0 : 0,
  }
}

async function ask(messages) {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 96, stream: false }),
    })
    const body = await response.json().catch(() => null)
    const latency = Date.now() - started
    if (!response.ok) return { ok: false, reply: '', latency, error: body?.error?.code || `http ${response.status}` }
    return { ok: true, reply: body?.choices?.[0]?.message?.content ?? '', latency }
  } catch (error) {
    return { ok: false, reply: '', latency: Date.now() - started, error: String(error.message || error) }
  }
}

async function main() {
  const rows = []
  for (const task of TASKS) {
    for (const state of ['off', 'on']) {
      start(state)
      if (!(await waitHealthy())) { console.error(`not healthy for ${state}`); process.exit(1) }
      const answer = await ask(messagesFor(task))
      const pass = answer.ok && normalise(answer.reply).includes(normalise(task.expect))
      const effect = treatmentFired()
      rows.push({ id: task.id, arm: ARM, state, pass, ok: answer.ok, error: answer.error ?? null, reply: String(answer.reply).slice(0, 160), latency: answer.latency, effect })
      process.stdout.write(`\r  ${task.id} ${state}=${answer.ok ? (pass ? 'PASS' : 'wrong') : 'ERR ' + answer.error}    `)
      if (!(answer.ok && answer.error !== 'qwen_ai_token_refresh_gated')) {
        await new Promise((r) => setTimeout(r, GAP))
      }
    }
  }
  process.stdout.write('\n')

  const off = rows.filter((r) => r.state === 'off')
  const on = rows.filter((r) => r.state === 'on')
  const offPass = off.filter((r) => r.pass).length
  const onPass = on.filter((r) => r.pass).length
  const errors = rows.filter((r) => !r.ok)

  console.log('')
  console.log(`  Arm ${ARM}   off ${offPass}/${off.length}   on ${onPass}/${on.length}`)
  if (errors.length > 0) {
    const kinds = {}
    for (const e of errors) kinds[e.error] = (kinds[e.error] || 0) + 1
    console.log(`  transport errors: ${JSON.stringify(kinds)}`)
    console.log('  These are NOT quality results. A rate-limited run measures nothing.')
  }
  const onRows = rows.filter((r) => r.state === 'on')
  const fired = onRows.filter((r) => r.effect && r.effect.changedMessageCount > 0).length
  console.log('')
  console.log(`  treatment fired on ${fired}/${onRows.length} on-requests`)
  if (fired === 0) {
    console.log('  VERDICT: INVALID. The features never rewrote anything, so this')
    console.log('  comparison shows the model twice and measures nothing.')
  }

  const usable = rows.length - errors.length
  console.log(`  usable comparisons: ${usable}/${rows.length}`)
  if (usable < rows.length) {
    console.log('  Verdict: INCOMPLETE. The pool rate limit blocked part of this run.')
  } else {
    const regressions = rows.filter((r) => r.state === 'on' && !r.pass && r.id && off.find((o) => o.id === r.id && o.pass))
    console.log(`  regressions: ${regressions.length}`)
    for (const r of regressions) console.log(`    ${r.id}: on -> ${JSON.stringify(r.reply.slice(0, 60))}`)
  }

  fs.mkdirSync('scripts/compress/tmp', { recursive: true })
  fs.writeFileSync(`scripts/compress/tmp/interleaved-${ARM}.json`, JSON.stringify({ arm: ARM, rows, offPass, onPass, errors: errors.length }, null, 1))
  console.log(`  written scripts/compress/tmp/interleaved-${ARM}.json`)
}

main().catch((error) => { console.error('crashed:', error); process.exitCode = 1 })
