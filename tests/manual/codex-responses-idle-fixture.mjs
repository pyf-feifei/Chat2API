import http from 'node:http'
import { spawn } from 'node:child_process'

const port = Number.parseInt(process.env.PORT || '18082', 10)
const contentDelayMs = Number.parseInt(process.env.CONTENT_DELAY_MS || '2500', 10)
const progressIntervalMs = Number.parseInt(process.env.PROGRESS_INTERVAL_MS || '200', 10)
const progressMode = process.env.PROGRESS_MODE || 'typed'
const runCodex = process.env.RUN_CODEX === '1'
const responseId = 'resp_idle_fixture'
const createdAt = Math.floor(Date.now() / 1000)
let sequenceNumber = 0

function responseObject(status, output = [], usage = null) {
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'fixture-model',
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage,
    user: null,
    metadata: {},
  }
}

function writeEvent(response, type, fields) {
  const event = { type, sequence_number: sequenceNumber, ...fields }
  sequenceNumber += 1
  response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  request.resume()
  request.on('end', () => {
    sequenceNumber = 0
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const inProgress = responseObject('in_progress')
    writeEvent(response, 'response.created', { response: inProgress })
    writeEvent(response, 'response.in_progress', { response: inProgress })

    const progressTimer = setInterval(() => {
      if (response.destroyed) return
      if (progressMode === 'typed') {
        writeEvent(response, 'response.in_progress', { response: inProgress })
      } else if (progressMode === 'comment') {
        response.write(': keep-alive\n\n')
      }
    }, progressIntervalMs)

    const contentTimer = setTimeout(() => {
      if (response.destroyed) return
      clearInterval(progressTimer)
      const item = {
        id: 'msg_idle_fixture',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'fixture complete', annotations: [], logprobs: [] }],
      }
      writeEvent(response, 'response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      })
      writeEvent(response, 'response.content_part.added', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      })
      writeEvent(response, 'response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: 'fixture complete',
        logprobs: [],
      })
      writeEvent(response, 'response.output_text.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: 'fixture complete',
        logprobs: [],
      })
      writeEvent(response, 'response.content_part.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      })
      writeEvent(response, 'response.output_item.done', { output_index: 0, item })
      writeEvent(response, 'response.completed', {
        response: responseObject('completed', [item], {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3,
        }),
      })
      response.end()
    }, contentDelayMs)

    response.once('close', () => {
      clearInterval(progressTimer)
      clearTimeout(contentTimer)
    })
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`codex-responses-idle-fixture listening on ${port} mode=${progressMode}\n`)
  if (!runCodex) return

  const provider = `{ name = "Idle fixture", base_url = "http://127.0.0.1:${port}/v1", env_key = "CHAT2API_IDLE_FIXTURE_KEY", wire_api = "responses", stream_idle_timeout_ms = 1000, stream_max_retries = 0 }`
  const codexJs = process.env.CODEX_JS
  const codexArgs = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--model',
    'fixture-model',
    '--config',
    'model_provider="idlefixture"',
    '--config',
    `model_providers.idlefixture=${provider}`,
    '--config',
    'web_search="disabled"',
    'Reply once with the model output and do not use tools.',
  ]
  const child = spawn(codexJs ? process.execPath : 'codex', [
    ...(codexJs ? [codexJs] : []),
    ...codexArgs,
  ], {
    env: {
      ...process.env,
      CHAT2API_IDLE_FIXTURE_KEY: 'fixture-key',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: 'inherit',
    shell: process.platform === 'win32' && !codexJs,
    windowsHide: true,
  })

  child.once('error', error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    server.close(() => process.exit(1))
  })
  child.once('exit', (code, signal) => {
    process.stdout.write(`codex exit: code=${code} signal=${signal || 'none'}\n`)
    server.close(() => process.exit(code ?? 1))
  })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
