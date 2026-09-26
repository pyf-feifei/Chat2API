/**
 * Quality validation for the token-reduction features, one container state.
 *
 * The features are opt-in environment variables, not per-request options, so
 * "off" and "on" are two CONTAINER STATES. Asking the same request twice
 * against one container measures the weather twice. This script therefore runs
 * every task exactly once and writes a result file; `run-quality-ab.mjs`
 * starts a features-off container, runs this, starts a features-on container,
 * runs it again, and diffs.
 *
 * Two arms, because these features are lossy by design:
 *
 *   Arm A — regression. Tasks answerable from the current turn alone. Nothing
 *           the features remove is load bearing, so success rate must not drop.
 *           This is the acceptance gate.
 *   Arm B — tradeoff. The answer exists only in old context. The features are
 *           expected to hurt. There is no pass condition; the number is the
 *           price of the saving.
 *
 * Every task has a checkable expected value, so nothing depends on a judge.
 *
 * Usage: node scripts/compress/quality-one-state.mjs --key <k> --out <file> [--limit N]
 */

import fs from 'node:fs'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8080')
const KEY = arg('key', '')
const OUT = arg('out', 'scripts/compress/tmp/quality.json')
const LABEL = arg('label', 'unknown')
const LIMIT = Number(arg('limit', '12'))
const MODEL = arg('model', 'Qwen3.8-Max')
/**
 * Seconds between requests.
 *
 * A first run sent 24 tasks per arm back to back and the second arm never ran:
 * the first request drew a content verdict, the risk-control circuit opened for
 * 580 s, and every remaining request was refused by the circuit rather than by
 * the features. The measured "-75 pp" was the rate limit, not quality.
 *
 * 339 accounts behind one egress is itself the anomaly shape AGENTS.md warns
 * about, so a verification run has to stay under it or it measures nothing.
 */
const GAP_MS = Number(arg('gap', '15000'))

if (!KEY) { console.error('missing --key'); process.exit(1) }

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

const REGRESSION_TASKS = [
  { id: 'sum', arm: 'A', prompt: 'What is 137 + 486? Reply with only the number.', expect: '623' },
  { id: 'reverse', arm: 'A', prompt: 'Reverse the string "chat2api". Reply with only the reversed string.', expect: 'ip2tahc' },
  { id: 'json', arm: 'A', prompt: 'Reply with only valid JSON, no prose: {"a": [1, 2], "b": "x"}', expect: '"a": [1, 2]' },
  { id: 'count', arm: 'A', prompt: 'How many words are in this sentence: the quick brown fox jumps? Reply with only the number.', expect: '6' },
  { id: 'lower', arm: 'A', prompt: 'Convert "MiXeD CaSe" to lowercase. Reply with only the lowercase result.', expect: 'mixed case' },
  { id: 'primary', arm: 'A', prompt: 'List the three primary colors. Reply with only a comma-separated list.', expect: 'red' },
  { id: 'multiply', arm: 'A', prompt: 'What is 24 times 37? Reply with only the number.', expect: '888' },
  { id: 'sort', arm: 'A', prompt: 'Sort these ascending and reply with only the result: pear, apple, fig', expect: 'apple' },
  { id: 'subtract', arm: 'A', prompt: 'What is 1000 minus 258? Reply with only the number.', expect: '742' },
  { id: 'upper', arm: 'A', prompt: 'Convert "proxy" to uppercase. Reply with only the uppercase result.', expect: 'PROXY' },
  { id: 'chars', arm: 'A', prompt: 'How many characters are in "chat2api"? Reply with only the number.', expect: '7' },
  { id: 'jsonarr', arm: 'A', prompt: 'Reply with only a JSON array of the first 4 positive integers.', expect: '[1, 2, 3, 4]' },
  { id: 'divide', arm: 'A', prompt: 'What is 144 divided by 12? Reply with only the number.', expect: '12' },
  { id: 'caps', arm: 'A', prompt: 'Convert "compress" to uppercase. Reply with only the uppercase result.', expect: 'COMPRESS' },
  { id: 'vowels', arm: 'A', prompt: 'How many vowels are in "sequoia"? Reply with only the number.', expect: '4' },
  { id: 'largest', arm: 'A', prompt: 'What is the largest of 91, 187 and 46? Reply with only the number.', expect: '187' },
]

const TRADEOFF_TASKS = [
  { id: 'old-pin', arm: 'B', first: 'Remember this: my account PIN is 7734. Do not mention it unless asked.', prompt: 'What is my account PIN? Reply with only the 4 digits.', expect: '7734' },
  { id: 'old-fruit', arm: 'B', first: 'Remember this: my favourite fruit is kiwi.', prompt: 'What is my favourite fruit? Reply with only the word.', expect: 'kiwi' },
  { id: 'old-room', arm: 'B', first: 'Remember this: the room number is 4127.', prompt: 'Which room number did I tell you? Reply with only the number.', expect: '4127' },
  { id: 'old-word', arm: 'B', first: 'Remember this word: quartzite.', prompt: 'What word did I tell you to remember? Reply with only the word.', expect: 'quartzite' },
  { id: 'old-code', arm: 'B', first: 'Remember this: the code is 9058.', prompt: 'What code did I give you? Reply with only the number.', expect: '9058' },
  { id: 'old-animal', arm: 'B', first: 'Remember this: my favourite animal is the pangolin.', prompt: 'What is my favourite animal? Reply with only the animal.', expect: 'pangolin' },
  { id: 'old-city', arm: 'B', first: 'Remember this: I am flying to Kyoto.', prompt: 'Which city am I flying to? Reply with only the city name.', expect: 'Kyoto' },
  { id: 'old-sum', arm: 'B', first: 'Remember this number: 5567.', prompt: 'Add 1000 to the number I told you. Reply with only the result.', expect: '6567' },
]

function buildMessages(task) {
  const system = { role: 'system', content: 'Answer exactly as instructed. Be brief.' }
  if (task.arm === 'A') return [system, { role: 'user', content: task.prompt }]
  return [
    system,
    { role: 'user', content: task.first },
    { role: 'user', content: FILLER },
    { role: 'user', content: FILLER },
    { role: 'user', content: task.prompt },
  ]
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
    if (!response.ok) {
      return { ok: false, reply: '', latency, error: body?.error?.code || `http ${response.status}` }
    }
    return {
      ok: true,
      reply: body?.choices?.[0]?.message?.content ?? '',
      latency,
      finishReason: body?.choices?.[0]?.finish_reason,
      toolCallCount: Array.isArray(body?.choices?.[0]?.message?.tool_calls)
        ? body.choices[0].message.tool_calls.length
        : 0,
    }
  } catch (error) {
    return { ok: false, reply: '', latency: Date.now() - started, error: String(error.message || error) }
  }
}

function correct(reply, expected) {
  const normalise = (value) => String(value || '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/\s+/g, '')
  return normalise(reply).includes(normalise(expected))
}

const ARM = arg('arm', 'all')
const ALL = ARM === 'B' ? TRADEOFF_TASKS
  : ARM === 'A' ? REGRESSION_TASKS
  : [...REGRESSION_TASKS, ...TRADEOFF_TASKS]
const TASKS = ALL.slice(0, LIMIT)

async function main() {
  const health = await fetch(`${BASE}/health`)
  if (!health.ok) { console.error(`service not healthy: ${health.status}`); process.exit(1) }

  const results = []
  let index = 0
  for (const task of TASKS) {
    index += 1
    const answer = await ask(buildMessages(task))
    const pass = answer.ok && correct(answer.reply, task.expect)
    results.push({
      id: task.id,
      arm: task.arm,
      expect: task.expect,
      pass,
      ok: answer.ok,
      error: answer.error ?? null,
      reply: String(answer.reply).slice(0, 160),
      latency: answer.latency,
      toolCallCount: answer.toolCallCount ?? 0,
      finishReason: answer.finishReason ?? null,
    })
    const mark = pass ? 'PASS' : (answer.ok ? 'wrong' : 'ERR ')
    process.stdout.write(`\r  [${LABEL}] ${index}/${TASKS.length} ${task.id} ${mark}      `)
  }
  process.stdout.write('\n')

  const armA = results.filter((r) => r.arm === 'A')
  const armB = results.filter((r) => r.arm === 'B')
  const summary = {
    label: LABEL,
    model: MODEL,
    at: new Date().toISOString(),
    armA: {
      n: armA.length,
      pass: armA.filter((r) => r.pass).length,
      errors: armA.filter((r) => !r.ok).length,
      medianLatency: median(armA.map((r) => r.latency)),
      toolCallTotal: armA.reduce((s, r) => s + r.toolCallCount, 0),
    },
    armB: {
      n: armB.length,
      pass: armB.filter((r) => r.pass).length,
      errors: armB.filter((r) => !r.ok).length,
      medianLatency: median(armB.map((r) => r.latency)),
      toolCallTotal: armB.reduce((s, r) => s + r.toolCallCount, 0),
    },
    results,
  }
  fs.mkdirSync('scripts/compress/tmp', { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 1))
  console.log(`  arm A ${summary.armA.pass}/${summary.armA.n}   arm B ${summary.armB.pass}/${summary.armB.n}`
    + `   errors ${summary.armA.errors + summary.armB.errors}`)
  console.log(`  written ${OUT}`)
}

function median(values) {
  const sorted = [...values].filter((v) => typeof v === 'number').sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}

main().catch((error) => { console.error('crashed:', error); process.exitCode = 1 })
