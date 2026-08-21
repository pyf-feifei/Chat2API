/**
 * Manual real-request load test for the Anthropic Messages API endpoint.
 * Hits POST /v1/messages on a running Chat2API proxy with real upstream traffic.
 *
 * Env knobs:
 *   BASE_URL, API_KEY, MODEL, TOTAL, CONCURRENCY, MAX_TOKENS,
 *   STREAM_RATIO (0..1), REQUEST_TIMEOUT_MS
 */
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080'
const API_KEY = process.env.API_KEY
const MODEL = process.env.MODEL || 'Qwen3.8-Max_Auto'
const TOTAL = Number(process.env.TOTAL || 20)
const CONCURRENCY = Number(process.env.CONCURRENCY || 5)
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 60)
const STREAM_RATIO = Number(process.env.STREAM_RATIO || 0.5)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000)
const STREAM_COUNT = Math.round(TOTAL * Math.min(1, Math.max(0, STREAM_RATIO)))

const prompts = [
  'Say hello in one short sentence.',
  'What is 27 * 43? Reply with just the number.',
  'Name one ocean in at most three words.',
  'Give a one-line tip for writing clean code.',
  'Translate "good morning" into French. Reply with only the translation.',
]

const results = []

async function runOne(index) {
  const stream = Math.floor(((index + 1) * STREAM_COUNT) / TOTAL)
    > Math.floor((index * STREAM_COUNT) / TOTAL)
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream,
    messages: [{ role: 'user', content: prompts[index % prompts.length] }],
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const started = performance.now()
  let firstByteMs = null
  let status = 0
  let ok = false
  let error = null
  const eventCounts = {}
  let textLen = 0
  try {
    const resp = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    status = resp.status
    if (!resp.ok) {
      error = (await resp.text()).slice(0, 300)
    } else if (stream) {
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstByteMs === null) firstByteMs = performance.now() - started
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
          if (!dataLine) continue
          try {
            const event = JSON.parse(dataLine.slice(6))
            eventCounts[event.type] = (eventCounts[event.type] || 0) + 1
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              textLen += event.delta.text.length
            }
          } catch {}
        }
      }
      ok = status === 200 && (eventCounts.message_stop || 0) === 1
      if (!ok && !error) error = `unexpected stream events: ${JSON.stringify(eventCounts)}`
    } else {
      const data = await resp.json()
      firstByteMs = performance.now() - started
      ok = status === 200 && data.type === 'message' && Array.isArray(data.content)
      if (ok) {
        textLen = data.content
          .filter((block) => block.type === 'text')
          .reduce((sum, block) => sum + (block.text || '').length, 0)
      } else if (!error) {
        error = JSON.stringify(data).slice(0, 300)
      }
    }
  } catch (err) {
    error = String((err && err.message) || err)
  } finally {
    clearTimeout(timer)
  }
  results.push({
    index,
    stream,
    status,
    ok,
    totalMs: performance.now() - started,
    firstByteMs,
    textLen,
    error,
  })
  process.stdout.write(ok ? '.' : 'x')
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function fmt(ms) {
  return ms === null || ms === undefined ? 'n/a' : `${Math.round(ms)}ms`
}

async function main() {
  if (!API_KEY) {
    throw new Error('API_KEY is required')
  }
  console.log(
    `Real-request load test: ${BASE_URL}/v1/messages model=${MODEL} total=${TOTAL} concurrency=${CONCURRENCY} streamRatio=${STREAM_RATIO} maxTokens=${MAX_TOKENS}`,
  )
  const startedAt = Date.now()
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const index = next++
        if (index >= TOTAL) break
        await runOne(index)
      }
    }),
  )
  const wallMs = Date.now() - startedAt
  process.stdout.write('\n')
  const okResults = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  const latencies = okResults.map((r) => r.totalMs).sort((a, b) => a - b)
  const ttfbs = okResults
    .map((r) => r.firstByteMs)
    .filter((v) => v !== null && v !== undefined)
    .sort((a, b) => a - b)
  const byStatus = {}
  for (const r of results) {
    const key = r.status || 'network_error'
    byStatus[key] = (byStatus[key] || 0) + 1
  }
  console.log('--- Summary ---')
  console.log(`Wall time: ${(wallMs / 1000).toFixed(1)}s | Throughput: ${(TOTAL / (wallMs / 1000)).toFixed(2)} req/s`)
  console.log(`Success: ${okResults.length}/${TOTAL} | Failed: ${failed.length} | Status codes: ${JSON.stringify(byStatus)}`)
  console.log(`Total latency p50=${fmt(percentile(latencies, 0.5))} p95=${fmt(percentile(latencies, 0.95))} p99=${fmt(percentile(latencies, 0.99))} max=${fmt(latencies.at(-1))}`)
  console.log(`First byte    p50=${fmt(percentile(ttfbs, 0.5))} p95=${fmt(percentile(ttfbs, 0.95))}`)
  const streamTotal = results.filter((r) => r.stream).length
  const streamOk = results.filter((r) => r.stream && r.ok).length
  console.log(`Streaming: ${streamOk}/${streamTotal} ok | Non-streaming: ${okResults.length - streamOk}/${TOTAL - streamTotal} ok`)
  if (failed.length > 0) {
    console.log('Failures (first 5):')
    for (const f of failed.slice(0, 5)) {
      console.log(`  #${f.index} stream=${f.stream} status=${f.status} error=${f.error}`)
    }
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
