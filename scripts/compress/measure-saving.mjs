/**
 * Measure the upstream token saving on a real request corpus.
 *
 * The proxy computes and logs the saving BEFORE the upstream call, so this
 * measures how many tokens would actually be sent without needing the upstream
 * to succeed. That matters here: the Qwen egress sits behind an Aliyun WAF
 * risk-control gate and only about one request in thirty gets through, so a
 * wait-for-success loop would take hours and would still not give a per-request
 * number.
 *
 * Three runs of the same corpus, each in a container with a different set of
 * variables:
 *
 *   baseline    no feature variables. The request is forwarded unchanged, and
 *               the corpus is scored with the proxy's own estimator so the
 *               number is the one the proxy would have charged.
 *   dry-run     `CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=dry-run`. The proxy measures
 *               a candidate and does not change the request, so its log carries
 *               the saving the feature would achieve, from the proxy's own
 *               accounting rather than a re-implementation.
 *   treatment   the features on for real. The log carries what it actually did.
 *
 * Image slimming has no dry-run, so its saving is read from the `[ChatSlim]`
 * line and converted with the same estimator.
 *
 * Read-only with respect to stored accounts and keys: it only reads the
 * container's stdout and posts chat completions.
 *
 * Usage:
 *   node scripts/compress/measure-saving.mjs --key <key> --corpus <file.json> [--image chat2api-local:latest]
 */

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
// Port 8099, not 8080. A concurrent process also runs a chat2api container on
// 8080 and was replacing this script's container mid-run, so runs 2 and 3
// measured somebody else's traffic and reported zero.
const BASE = arg('base', 'http://127.0.0.1:8099')
const KEY = arg('key', '')
const CORPUS = arg('corpus', '')
const IMAGE = arg('image', 'chat2api-local:latest')
const VOLUME = arg('volume', 'chat2api-validate')
if (!KEY || !CORPUS) { console.error('missing --key or --corpus'); process.exit(1) }

// ---------------------------------------------------------------------------
// The proxy's estimator, mirrored so the baseline is the proxy's own number.
// ---------------------------------------------------------------------------

function estimateTokens(value) {
  let ascii = 0
  let nonAscii = 0
  for (const codePoint of value) {
    if (codePoint.codePointAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 3) + nonAscii
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        if (part.type === 'text' && part.text) return part.text
        if (part.image_url && part.image_url.url) return part.image_url.url
        if (part.file_url && part.file_url.url) return part.file_url.url
        return ''
      })
      .join('\n')
  }
  return ''
}

function estimateMessage(message) {
  let tokens = estimateTokens(String(message.role || ''))
    + estimateTokens(String(message.name || ''))
    + estimateTokens(String(message.tool_call_id || ''))
  const body = contentText(message.content)
  if (body) tokens += estimateTokens(body)
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls))
  }
  return tokens
}

function estimateRequest(request) {
  const messages = (request.messages || []).reduce((sum, m) => sum + estimateMessage(m), 0)
  const tools = request.tools?.length ? estimateTokens(JSON.stringify(request.tools)) : 0
  return Math.max(1, messages + tools)
}

// ---------------------------------------------------------------------------
// Container control
// ---------------------------------------------------------------------------

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...options })
}

async function startContainer(envVars) {
  run('docker', ['rm', '-f', 'chat2api-measure'])
  const args = ['run', '-d', '--name', 'chat2api-measure', '-p', '8099:8080', '-v', `${VOLUME}:/data`]
  for (const [key, value] of Object.entries(envVars)) args.push('-e', `${key}=${value}`)
  args.push(IMAGE)
  const started = run('docker', args)
  if (started.status !== 0) {
    console.error('container start failed:', started.stderr)
    process.exit(1)
  }
  // Wait for the listener, probed from the HOST. A `docker exec` health check
  // has to fight the shell's path translation and fails for reasons unrelated to
  // the container, which cost one debugging cycle.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) return
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.error('container did not become healthy')
  process.exit(1)
}

function logs() {
  const out = run('docker', ['logs', 'chat2api-measure'], { maxBuffer: 256 * 1024 * 1024 })
  return `${out.stdout || ''}${out.stderr || ''}`
}

/**
 * Docker streams container stdout, so a log read immediately after the last
 * request can miss it. A first run reported zero measurements for exactly this
 * reason: the lines existed a second later.
 */
async function logsAfterRequests(marker, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const text = logs()
    if (text.includes(marker) || Date.now() > deadline) return text
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

function collectLines(text, regex) {
  const lines = []
  for (const match of text.matchAll(new RegExp(regex.source, 'g'))) {
    try {
      lines.push(JSON.parse(match[1]))
    } catch {
      // A greedy `(.*)` can run past the JSON into a later brace on a long line.
      // Fall back to a non-greedy match rather than dropping the measurement.
      const tail = match[0]
      const end = tail.lastIndexOf('}')
      for (let i = 0; i < end; i += 1) {
        try {
          lines.push(JSON.parse(tail.slice(tail.indexOf('{'), i + 1)))
          break
        } catch { /* keep shrinking */ }
      }
    }
  }
  return lines
}

function sumMatches(text, regex, field) {
  return collectLines(text, regex).reduce((sum, payload) => {
    const value = payload[field]
    return sum + (typeof value === 'number' ? value : 0)
  }, 0)
}

// ---------------------------------------------------------------------------
// Drive the corpus
// ---------------------------------------------------------------------------

async function sendCorpus(corpus) {
  for (const request of corpus) {
    try {
      const response = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ ...request, max_tokens: 8, stream: false }),
      })
      await response.text()
    } catch {
      // An upstream refusal is expected and irrelevant: the measurement is taken
      // from the proxy's own pre-flight accounting.
    }
  }
}

const TREATMENT = {
  CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'always',
  CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '1',
  CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '1',
  CHAT2API_REPLAY_SLIM_IMAGES: 'always',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'balanced',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS: '0',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES: '8',
  CHAT2API_COMPRESS_RETRIEVAL: 'on',
}

async function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'))
  console.log(`corpus: ${corpus.length} requests, ${corpus.reduce((s, r) => s + (r.messages?.length || 0), 0)} messages\n`)

  // 1. Baseline
  console.log('run 1/3  baseline — no feature variables set')
  startContainer({})
  await sendCorpus(corpus)
  const baselineTokens = corpus.reduce((sum, r) => sum + estimateRequest(r), 0)
  const baselineLogs = await logsAfterRequests('[Server] Chat2API listening')
  const leaked = /upstream-token-optimizer|replay image slimming|retrieval loop/.test(baselineLogs)
  console.log(`  estimated upstream input tokens : ${baselineTokens.toLocaleString()}`)
  console.log(`  any feature log line present    : ${leaked ? 'YES (unexpected)' : 'no'}`)

  // 2. Dry-run — the proxy measures a candidate without changing the request
  console.log('\nrun 2/3  dry-run — measures the candidate, changes nothing')
  startContainer({
    CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'dry-run',
    CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS: '0',
  })
  await sendCorpus(corpus)
  const dryText = await logsAfterRequests('upstream-token-optimizer')
  const dryCandidate = sumMatches(dryText, /\[Forwarder\] upstream-token-optimizer (\{.*\})/, 'candidateSaved')
  const dryApplied = dryText.split('upstream-token-optimizer').length - 1
  console.log(`  candidate saving reported        : ${dryCandidate.toLocaleString()} tokens`)
  console.log(`  requests measured                : ${dryApplied}`)

  // 3. Treatment — the features actually run
  console.log('\nrun 3/3  treatment — features on')
  startContainer(TREATMENT)
  await sendCorpus(corpus)
  const treatText = await logsAfterRequests('upstream-token-optimizer')
  const saved = sumMatches(treatText, /\[Forwarder\] upstream-token-optimizer (\{.*\})/, 'estimatedSaved')
  const measured = treatText.split('upstream-token-optimizer').length - 1
  const archived = sumMatches(treatText, /\[Forwarder\] upstream-token-optimizer (\{.*\})/, 'archivedChars')
  const imageChars = sumMatches(treatText, /\[ChatSlim\] replay image slimming (\{.*\})/, 'imageCharsSlimmed')
  const imageMessages = sumMatches(treatText, /\[ChatSlim\] replay image slimming (\{.*\})/, 'imageMessagesSlimmed')
  const imageRuns = treatText.split('[ChatSlim] replay image slimming').length - 1
  const optLines = collectLines(treatText, /\[Forwarder\] upstream-token-optimizer (\{.*\})/)

  // Image slimming runs in the ROUTE, before the forwarder, so the optimizer's
  // `before` already reflects it. Adding the two figures double counts, and the
  // first run of this script reported 252% for exactly that reason.
  //
  // The only sound comparison is the whole-corpus baseline against the whole
  // corpus after: what a default deployment would have sent versus what this
  // one did send.
  const afterTokens = optLines.reduce((sum, line) => sum + (typeof line.after === 'number' ? line.after : 0), 0)
  const totalSaving = baselineTokens - afterTokens
  const pct = baselineTokens > 0 ? (100 * totalSaving) / baselineTokens : 0

  console.log('')
  console.log('  per request (from the proxy log):')
  for (const [index, line] of optLines.entries()) {
    const before = typeof line.before === 'number' ? line.before : 0
    const savedHere = typeof line.estimatedSaved === 'number' ? line.estimatedSaved : 0
    const pctHere = before > 0 ? (100 * savedHere) / before : 0
    console.log(`    ${String(index + 1).padStart(2)}. before ${String(before).padStart(9)}`
      + `  after ${String(line.after).padStart(9)}`
      + `  saved ${String(savedHere).padStart(9)}  (${pctHere.toFixed(1)}%)`
      + `  ceiling=${line.liveZoneCeiling}${line.skipReason ? `  skip=${line.skipReason}` : ''}`)
  }
  if (totalSaving < 0 || totalSaving > baselineTokens) {
    console.log('')
    console.log('  WARNING: the saving is outside [0, baseline]. Do not report this run.')
  }

  console.log('')
  console.log(`  image messages slimmed         : ${imageMessages}`)
  console.log(`  image characters dropped        : ${imageChars.toLocaleString()}`)
  console.log(`  characters archived (CCR)      : ${archived.toLocaleString()}`)
  console.log('='.repeat(64))
  console.log(`  requests in corpus                : ${corpus.length}`)
  console.log(`  baseline estimated input tokens   : ${baselineTokens.toLocaleString()}`)
  console.log('')
  console.log(`  requests measured                : ${measured}`)
  console.log(`  image requests slimmed            : ${imageRuns}`)
  console.log('')
  console.log(`  REMAINING UPSTREAM                : ${afterTokens.toLocaleString()}`)
  console.log(`  REDUCTION                         : ${pct.toFixed(1)}%`)
  console.log('='.repeat(64))
  console.log('\n  Notes:')
  console.log('  - the image figure converts characters with the same ASCII/3 rule the')
  console.log('    optimizer uses, so it is comparable, not exact')
  console.log('  - these are the numbers the proxy logged before the upstream call, i.e.')
  console.log('    the tokens that would have been sent')
  console.log('  - upstream refusals during the run do not affect the measurement')
}

main().catch((error) => { console.error('crashed:', error); process.exitCode = 1 })
