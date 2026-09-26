/**
 * Quality validation for the token-reduction features.
 *
 * These features are lossy by design: image slimming replaces old screenshots
 * with a placeholder, and balanced mode drops old tool output. A quality gate
 * therefore cannot be a single number, because there are two different
 * questions and only one of them has a pass condition.
 *
 *   Arm A — regression. Tasks answerable from the CURRENT turn alone. Compression
 *           should be invisible here, because nothing it removes was load
 *           bearing. This is the acceptance gate: success rate must not drop.
 *
 *   Arm B — tradeoff. Tasks that REQUIRE old context. Compression is expected to
 *           hurt these. There is no pass condition; the number quantifies the
 *           price of the saving, and it is what an operator trades against.
 *
 * Every task is asked twice through the same model, once with the features off
 * and once on, and the two answers are compared against a checkable expected
 * value. Nothing here relies on a subjective judge.
 *
 * Usage:
 *   node scripts/compress/validate-quality.mjs --key <key> [--limit 12]
 */

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8080')
const KEY = arg('key', '')
const LIMIT = Number(arg('limit', '12'))
const MODEL = arg('model', 'Qwen3.8-Max')

if (!KEY) { console.error('missing --key'); process.exit(1) }

// ---------------------------------------------------------------------------
// Task construction
// ---------------------------------------------------------------------------

/** Filler that must NOT contain the answer, so an old-context task is honest. */
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

/**
 * Arm A. Answerable from the current turn alone. The expected value is a short
 * literal so scoring is exact rather than judged.
 */
const REGRESSION_TASKS = [
  { id: 'sum', prompt: 'What is 137 + 486? Reply with only the number.', expect: '623' },
  { id: 'reverse', prompt: 'Reverse the string "chat2api". Reply with only the reversed string.', expect: 'ip2tahc' },
  { id: 'json', prompt: 'Reply with only valid JSON, no prose: {"a": [1, 2], "b": "x"}', expect: '{"a":[1,2],"b":"x"}' },
  { id: 'count', prompt: 'How many words are in this sentence: the quick brown fox jumps? Reply with only the number.', expect: '6' },
  { id: 'case', prompt: 'Convert "MiXeD CaSe" to lowercase. Reply with only the lowercase result.', expect: 'mixed case' },
  { id: 'list', prompt: 'List the three primary colors. Reply with only a comma-separated list.', expect: 'red' },
  { id: 'multiply', prompt: 'What is 24 times 37? Reply with only the number.', expect: '888' },
  { id: 'sort', prompt: 'Sort these ascending and reply with only the result: pear, apple, fig', expect: 'apple' },
  { id: 'subtract', prompt: 'What is 1000 minus 258? Reply with only the number.', expect: '742' },
  { id: 'upper', prompt: 'Convert "proxy" to uppercase. Reply with only the uppercase result.', expect: 'PROXY' },
  { id: 'count2', prompt: 'How many characters are in "chat2api"? Reply with only the number.', expect: '7' },
  { id: 'jsonarr', prompt: 'Reply with only a JSON array of the first 4 positive integers.', expect: '[1,2,3,4]' },
]

/**
 * Arm B. The old context is the only source of the answer. The filler carries no
 * digits and no name, so recovering the value requires the first message to have
 * survived.
 */
const TRADEOFF_TASKS = [
  { id: 'old-number', first: 'Remember this: my account PIN is 7734. Do not mention it unless asked.', prompt: 'What is my account PIN? Reply with only the 4 digits.', expect: '7734' },
  { id: 'old-name', first: 'Remember this: my favourite fruit is kiwi.', prompt: 'What is my favourite fruit? Reply with only the word.', expect: 'kiwi' },
  { id: 'old-number2', first: 'Remember this: the room number is 4127.', prompt: 'Which room number did I tell you? Reply with only the number.', expect: '4127' },
  { id: 'old-word', first: 'Remember this word: quartzite.', prompt: 'What word did I tell you to remember? Reply with only the word.', expect: 'quartzite' },
  { id: 'old-number3', first: 'Remember this: the code is 9058.', prompt: 'What code did I give you? Reply with only the number.', expect: '9058' },
  { id: 'old-animal', first: 'Remember this: my favourite animal is the pangolin.', prompt: 'What is my favourite animal? Reply with only the animal.', expect: 'pangolin' },
]

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Normalized containment: the expected value must appear in the reply. */
function correct(reply, expected) {
  const text = String(reply || '').toLowerCase()
  return text.includes(String(expected).toLowerCase())
}

async function ask(messages, maxTokens = 80) {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, stream: false }),
    })
    const body = await response.json().catch(() => null)
    const latency = Date.now() - started
    if (!response.ok) return { ok: false, error: body?.error?.code || `http ${response.status}`, latency }
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
    return { ok: false, error: String(error.message || error), latency: Date.now() - started }
  }
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function runArm(name, tasks, buildMessages) {
  console.log(`\n${name}`)
  console.log('  task            off        on         verdict')
  let offPass = 0
  let onPass = 0
  let both = 0
  const onLatencies = []
  const offLatencies = []
  const details = []

  for (const task of tasks.slice(0, LIMIT)) {
    const messages = buildMessages(task)
    const off = await ask(messages)
    const on = await ask(messages)
    offLatencies.push(off.latency)
    onLatencies.push(on.latency)

    const offOk = off.ok && correct(off.reply, task.expect)
    const onOk = on.ok && correct(on.reply, task.expect)
    if (offOk) offPass += 1
    if (onOk) onPass += 1
    if (offOk && onOk) both += 1

    const verdict = offOk === onOk
      ? (offOk ? 'both' : 'both wrong')
      : (onOk ? 'REGRESSION' : 'IMPROVED')
    console.log(`  ${task.id.padEnd(14)} ${String(offOk).padEnd(10)} ${String(onOk).padEnd(10)} ${verdict}`
      + `${offOk && !onOk ? `  (on said: ${JSON.stringify(String(on.reply).slice(0, 40))})` : ''}`)
    details.push({ ...task, offOk, onOk, offReply: String(off.reply).slice(0, 80), onReply: String(on.reply).slice(0, 80), onError: on.error })
  }

  const n = Math.min(LIMIT, tasks.length)
  return {
    name, n, offPass, onPass, both, details,
    offRate: offPass / n,
    onRate: onPass / n,
    offLatency: median(offLatencies),
    onLatency: median(onLatencies),
  }
}

async function main() {
  const health = await fetch(`${BASE}/health`)
  if (!health.ok) { console.error(`service not healthy: ${health.status}`); process.exit(1) }
  const info = await health.json()
  console.log(`service up (${info.statistics?.totalRequests ?? '?'} requests seen)`)
  console.log(`model ${MODEL}, ${LIMIT} tasks per arm, each asked twice\n`)

  // Arm A needs no history at all, so the two runs are literally the same request
  // and any difference is the features acting on nothing.
  const armA = await runArm('Arm A — regression (current-turn tasks, compression should be invisible)',
    REGRESSION_TASKS, (task) => [
      { role: 'system', content: 'Answer exactly as instructed. Be brief.' },
      { role: 'user', content: task.prompt },
    ])

  // Arm B buries the answer under filler that compression may remove.
  const armB = await runArm('Arm B — tradeoff (answer lives only in old context)',
    TRADEOFF_TASKS, (task) => [
      { role: 'system', content: 'Answer exactly as instructed. Be brief.' },
      { role: 'user', content: task.first },
      { role: 'user', content: FILLER },
      { role: 'user', content: FILLER },
      { role: 'user', content: task.prompt },
    ])

  const delta = (100 * (armA.onRate - armA.offRate)) / Math.max(armA.n, 1)

  console.log('\n' + '='.repeat(68))
  console.log('QUALITY VALIDATION')
  console.log('='.repeat(68))
  console.log(`  Arm A  regression   off ${armA.offPass}/${armA.n}   on ${armA.onPass}/${armA.n}`
    + `   delta ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp`)
  console.log(`  Arm B  tradeoff     off ${armB.offPass}/${armB.n}   on ${armB.onPass}/${armB.n}`)
  console.log(`  median latency      off ${armA.offLatency}ms   on ${armA.onLatency}ms (arm A)`)
  console.log('='.repeat(68))

  const regressions = armA.details.filter((d) => d.offOk && !d.onOk)
  if (regressions.length > 0) {
    console.log(`\n  ${regressions.length} REGRESSION(S) on tasks that need no history:`)
    for (const r of regressions) console.log(`    ${r.id}: on -> ${JSON.stringify(r.onReply)}`)
    console.log('  The acceptance gate is a non-negative delta. This run fails it.')
  } else {
    console.log('\n  No regression on tasks answerable without history.')
  }

  const armBRegressions = armB.details.filter((d) => d.offOk && !d.onOk)
  if (armBRegressions.length > 0) {
    console.log(`\n  Arm B lost ${armBRegressions.length}/${armB.n} tasks whose answer lived only in old`)
    console.log('  context. That is the expected price of the saving, quantified:')
    for (const r of armBRegressions) console.log(`    ${r.id}: on -> ${JSON.stringify(r.onReply)}`)
  }

  if (armA.n < LIMIT) {
    console.log(`\n  NOTE: only ${armA.n} tasks ran per arm. At this sample size a single`)
    console.log('  flipped answer moves the rate by a large percentage point, so this')
    console.log('  bounds the effect, it does not establish it.')
  }
}

main().catch((error) => { console.error('crashed:', error); process.exitCode = 1 })
