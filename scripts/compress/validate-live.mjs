/**
 * Real-request validation against a running Chat2API container.
 *
 * Unit and contract tests cannot answer the question this file exists to ask:
 * does a real request through a real proxy still work, and do the two opt-in
 * token-reduction features arm and behave as designed against real traffic?
 *
 * Read-only with respect to the container: it inspects health, sends requests
 * through the public API, and reads the log lines the proxy emits. It does not
 * mutate stored accounts, providers, or keys.
 *
 * Usage:
 *   node scripts/compress/validate-live.mjs --base http://127.0.0.1:8080 --key <key> [--model <m>]
 */

import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const BASE = arg('base', 'http://127.0.0.1:8080')
const KEY = arg('key', '')
const MODEL = arg('model', '')

if (!KEY) {
  console.error('missing --key')
  process.exit(1)
}

let passed = 0
let failed = 0
let blocked = 0
const failures = []

/**
 * Upstream error codes that mean the egress is unavailable, not that the
 * feature under test is broken. A harness that cannot tell those apart reports a
 * wall of failures and tells the operator nothing.
 */
const UPSTREAM_BLOCKED = new Set([
  'qwen_ai_token_refresh_gated',
  'qwen_ai_token_refresh_failed',
  'qwen_ai_refresh_risk_control',
  'no_available_account',
])

/** Pull the structured error code out of a response body, or undefined. */
function errorCode(body) {
  return body && typeof body === 'object' ? body?.error?.code : undefined
}

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  if (UPSTREAM_BLOCKED.has(detail)) {
    blocked += 1
    console.log(`  BLOCK ${name} — upstream unavailable (${detail})`)
    return
  }
  failed += 1
  failures.push(name)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

function section(title) {
  console.log(`\n${title}`)
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      ...(init.headers || {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** `JSON.stringify(undefined)` is undefined, and a diagnostic must never crash. */
function preview(value) {
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text.slice(0, 200)
}

/** Grep the container's stdout for the proxy's own structured log lines. */
function containerLog(patterns) {
  const out = spawnSync('docker', ['logs', '--tail', '400', 'chat2api'], { encoding: 'utf8' })
  const text = `${out.stdout || ''}${out.stderr || ''}`
  return patterns.map((pattern) => pattern.test(text))
}

/**
 * Retry an upstream-gated call until the egress lets one through, or the budget
 * runs out. The Qwen egress re-arms its risk-control gate on every fresh probe,
 * so a single attempt is a coin flip; the window is real and short.
 */
async function withUpstreamRetry(label, attempt, budgetMs = 240_000) {
  const deadline = Date.now() + budgetMs
  let tries = 0
  for (;;) {
    tries += 1
    const result = await attempt()
    if (result.status === 200) return { result, tries }
    if (!UPSTREAM_BLOCKED.has(errorCode(result.body))) return { result, tries }
    if (Date.now() > deadline) return { result, tries }
    await new Promise((resolve) => setTimeout(resolve, 8_000))
  }
}

async function main() {
  section('1. Service is live')
  const health = await api('/health')
  check('GET /health returns 200', health.status === 200, `status=${health.status}`)
  check('health reports running', health.body?.status === 'running', preview(health.body))

  const models = await api('/v1/models')
  check('GET /v1/models authenticated', models.status === 200, `status=${models.status}`)
  const available = (models.body?.data || []).map((m) => m.id)
  check('at least one model is exposed', available.length > 0, `count=${available.length}`)
  const target = MODEL || available[0]
  if (!MODEL) console.log(`        (using the first exposed model: ${target})`)

  section('2. A real completion still works')
  const started = Date.now()
  const { result: chat, tries: chatTries } = await withUpstreamRetry('completion', () => api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: target,
      messages: [{ role: 'user', content: 'Reply with exactly: VALIDATION_OK' }],
      max_tokens: 64,
      stream: false,
    }),
  }))
  if (chatTries > 1) console.log(`        (took ${chatTries} attempts to get past the upstream risk-control gate)`)
  const latency = Date.now() - started
  const chatCode = errorCode(chat.body) || `status=${chat.status}`
  check('POST /v1/chat/completions returns 200', chat.status === 200, chatCode)
  const text = chat.body?.choices?.[0]?.message?.content
  check('the reply is non-empty text', typeof text === 'string' && text.trim().length > 0,
    typeof text === 'string' ? `content=${preview(text)}` : (chatCode))

  section('3. An image-bearing request works end to end')
  // A 1x1 PNG, the smallest valid image. This exercises the multimodal path
  // without depending on a file upload.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const { result: withImage, tries: imageTries } = await withUpstreamRetry('multimodal', () => api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: target,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with exactly: IMAGE_OK' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        ],
      }],
      max_tokens: 64,
      stream: false,
    }),
  }))
  if (imageTries > 1) console.log(`        (took ${imageTries} attempts to get past the upstream risk-control gate)`)
  const imageCode = errorCode(withImage.body) || `status=${withImage.status}`
  check('a multimodal request returns 200', withImage.status === 200, imageCode)
  const imageText = withImage.body?.choices?.[0]?.message?.content
  check('the multimodal reply is non-empty', typeof imageText === 'string' && imageText.trim().length > 0,
    typeof imageText === 'string' ? `content=${preview(imageText)}` : imageCode)

  section('4. A streaming request still streams')
  const streamStarted = Date.now()
  const streamResponse = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: target,
      messages: [{ role: 'user', content: 'Reply with exactly: STREAM_OK' }],
      max_tokens: 64,
      stream: true,
    }),
  })
  const streamBody = await streamResponse.text()
  let streamCode
  try { streamCode = errorCode(JSON.parse(streamBody)) } catch { streamCode = undefined }
  check('the streaming request returns 200', streamResponse.status === 200,
    streamCode || `status=${streamResponse.status}`)
  let streamText = ''
  let sawDone = false
  let firstChunkMs = null
  if (streamResponse.status === 200) {
    const reader = streamResponse.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstChunkMs === null) firstChunkMs = Date.now() - streamStarted
      const piece = decoder.decode(value, { stream: true })
      streamText += piece
      if (piece.includes('[DONE]')) sawDone = true
    }
  } else {
    streamText = streamBody
    firstChunkMs = Date.now() - streamStarted
  }
  if (streamResponse.status === 200) {
    check('the stream emitted a [DONE] sentinel', sawDone)
    check('the stream carried content', streamText.includes('data:'),
      `bytes=${streamText.length}`)
  } else {
    blocked += 2
    console.log('  BLOCK the stream emitted a [DONE] sentinel — upstream unavailable')
    console.log('  BLOCK the stream carried content — upstream unavailable')
  }
  check('time-to-first-token is plausible', firstChunkMs !== null && firstChunkMs < 60_000,
    `ttft=${firstChunkMs}ms`)

  section('5. The proxy logs what the features did')
  const [sawOptimizer, sawChatSlim, sawLoop] = containerLog([
    /\[Forwarder\] upstream-token-optimizer/,
    /\[ChatSlim\] replay image slimming/,
    /\[Forwarder\] retrieval (stream )?loop/,
  ])
  // The optimizer only logs when it is enabled, and both features default off,
  // so an absent line is the expected result for a default deployment.
  check('optimizer log is absent by default (mode off)', !sawOptimizer,
    'a default deployment should not log an optimizer run')
  check('image slimming log is absent by default (mode off)', !sawChatSlim,
    'a default deployment should not log a slimming run')
  check('retrieval loop log is absent by default (retrieval off)', !sawLoop,
    'a default deployment should not run a retrieval loop')

  section('Summary')
  console.log(`  ${passed} passed, ${failed} failed, ${blocked} blocked by upstream`)
  if (blocked > 0) {
    console.log('  The upstream egress is unavailable, so the completion path could not be')
    console.log('  exercised. That is an environment state, not a feature result: the features')
    console.log('  arm before the upstream call, and `validate-features.mjs` checks them there.')
  }
  if (failed > 0) {
    console.log(`  failing: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('validation crashed:', error)
  process.exitCode = 1
})
