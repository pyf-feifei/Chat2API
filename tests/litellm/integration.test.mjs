import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LITELLM_BASE_IMAGE = process.env.LITELLM_TEST_BASE_IMAGE
  || 'docker.litellm.ai/berriai/litellm:v1.93.0'
const LITELLM_IMAGE = 'chat2api-litellm:integration-test'
const LITELLM_MASTER_KEY = 'sk-litellm-offline-integration-test'
const MANAGEMENT_SECRET = 'mgmt_litellm_offline_integration_test'
const SYNTHETIC_CLIENT_MODEL = 'client-connectivity-probe'
const ADAPTIVE_MODEL_ALIAS = 'chat2api-adaptive-mock'
const RESPONSES_MODEL_ALIAS = 'chat2api-responses-mock'
const MOCK_PROVIDER_ID = 'litellm-offline-openai-mock'
const MOCK_MODEL_ALIAS = 'chat2api-mock'
const MOCK_UPSTREAM_MODEL = 'mock-model'
const MOCK_UPSTREAM_KEY = 'sk-mock-upstream-not-real'
const MIDSTREAM_ERROR_MODEL = 'litellm-midstream-error-mock'
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('bundled LiteLLM configuration keeps client probe and protocol bridge configurable', () => {
  const config = fs.readFileSync('deploy/litellm/config.yaml', 'utf8')
  const compose = fs.readFileSync('docker-compose.litellm.yml', 'utf8')
  const dockerfile = fs.readFileSync('deploy/litellm/Dockerfile', 'utf8')
  const patcher = fs.readFileSync(
    'deploy/litellm/apply-anthropic-midstream-error-patch.py',
    'utf8',
  )

  assert.match(config, /router_settings:\s*\r?\n\s+num_retries:\s*0\b/)
  assert.match(config, /litellm_params:[\s\S]*?num_retries:\s*0\b/)
  assert.match(config, /cancel_on_disconnect:\s*true\b/)
  assert.match(config, /use_chat_completions_url_for_anthropic_messages:\s*os\.environ\/LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES/)
  assert.match(config, /model_name:\s*["']\*["']/)
  assert.match(config, /model:\s*["']openai\/\*["']/)
  assert.match(config, /allowed_openai_params:\s*\[["']reasoning_effort["']\]/)
  assert.doesNotMatch(config, /api\.anthropic\.com|claude-[\w-]+/i)

  assert.doesNotMatch(config, /CHAT2API_CONNECTIVITY_MODEL/)
  assert.doesNotMatch(compose, /CHAT2API_CONNECTIVITY_MODEL/)
  assert.doesNotMatch(compose, /Qwen3\.8-Max-Preview/)
  assert.match(compose, /LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES:\s*"\$\{LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES:-true\}"/)
  assert.match(compose, /REQUEST_TIMEOUT:\s*"\$\{LITELLM_REQUEST_TIMEOUT:-900\}"/)
  assert.match(compose, /LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS:\s*"\$\{LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS:-15000\}"/)
  assert.match(compose, /LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY:\s*"\$\{LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY:-true\}"/)
  assert.match(compose, /LITELLM_BASE_IMAGE:\s*"\$\{LITELLM_BASE_IMAGE:-docker\.litellm\.ai\/berriai\/litellm:v1\.93\.0\}"/)
  assert.match(compose, /image:\s*"\$\{LITELLM_IMAGE:-chat2api-litellm:v1\.93\.0-anthropic-stream-guard\}"/)
  const serverCompose = fs.readFileSync('docker-compose.yml', 'utf8')
  const serverDockerfile = fs.readFileSync('Dockerfile', 'utf8')
  assert.match(serverCompose, /CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS:\s*\$\{CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS:-3\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS:\s*\$\{CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS:-1000\}/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS=3/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS=1000/)
  assert.match(dockerfile, /apply-anthropic-midstream-error-patch\.py/)
  assert.match(patcher, /Expected exactly one .*Refusing to apply a potentially unsafe patch/s)
  assert.match(patcher, /event: error\\\\ndata:/)
  assert.match(patcher, /event: ping\\\\ndata: \{\"type\":\"ping\"\}/)
  assert.match(patcher, /RESPONSES_MODULE_PATH/)
  assert.match(patcher, /responses_adapters/)
  assert.match(patcher, /RESPONSES_PATCHED_WRAPPER/)
  assert.match(patcher, /TOKEN_COUNTER_MODULE_PATH/)
  assert.match(patcher, /PROXY_SERVER_MODULE_PATH/)
  assert.match(patcher, /ANTHROPIC_ENDPOINTS_MODULE_PATH/)
  assert.match(patcher, /_chat2api_anthropic_image_url/)
  assert.match(patcher, /LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY/)
})

function captureOutput(child, maxLength = 64 * 1024) {
  let output = ''
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-maxLength)
  }

  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => output
}

async function reservePorts(count) {
  const servers = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer()
      server.unref()
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      servers.push(server)
    }

    return servers.map((server) => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      return address.port
    })
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return

  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])

  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
}

async function waitForHttp({ url, headers, child, output, timeoutMs, serviceName }) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${serviceName} exited before becoming ready (${child.exitCode}):\n${output()}`)
    }

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}: ${await response.text()}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error(
    `${serviceName} did not become ready: ${lastError}\n${output()}`,
  )
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { response, body, text }
}

function managementHeaders() {
  return {
    Authorization: `Bearer ${MANAGEMENT_SECRET}`,
    'Content-Type': 'application/json',
  }
}

function anthropicHeaders(apiKey = LITELLM_MASTER_KEY) {
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey,
  }
}

function anthropicRequest(overrides = {}) {
  return {
    model: MOCK_MODEL_ALIAS,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply from the offline mock.' }],
    ...overrides,
  }
}

function messageText(messages = []) {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join(' ')
  }).join('\n')
}

function openAiResponse(model, content) {
  return {
    id: 'chatcmpl-offline-mock',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
    },
  }
}

function openAiToolResponse(model) {
  return {
    id: 'chatcmpl-offline-tool-mock',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_offline_weather_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ city: 'Shanghai' }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      prompt_tokens: 17,
      completion_tokens: 8,
      total_tokens: 25,
    },
  }
}

function writeOpenAiStream(response, model) {
  const base = {
    id: 'chatcmpl-offline-stream-mock',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  }
  const chunks = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: 'offline ' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: 'stream reply' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

function writeOpenAiDelayedStream(response, model, delayMs = 450) {
  const base = {
    id: 'chatcmpl-offline-delayed-stream-mock',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  }
  const writeChunk = (delta, finishReason = null) => {
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  writeChunk({ role: 'assistant' })
  writeChunk({ content: 'before pause ' })

  setTimeout(() => {
    if (response.destroyed) return
    writeChunk({ content: 'after pause' })
    writeChunk({}, 'stop')
    response.end('data: [DONE]\n\n')
  }, delayMs).unref()
}

function writeOpenAiResponsesDelayedStream(response, model, delayMs = 450) {
  const writeEvent = (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })

  writeEvent({
    type: 'response.created',
    response: {
      id: 'resp-offline-thinking-mock',
      object: 'response',
      model,
      status: 'in_progress',
      output: [],
    },
  })
  writeEvent({
    type: 'response.output_item.added',
    item: { type: 'reasoning', id: 'rs_offline_1' },
  })
  writeEvent({
    type: 'response.reasoning_summary_text.delta',
    item_id: 'rs_offline_1',
    delta: 'before pause',
  })

  setTimeout(() => {
    if (response.destroyed) return

    writeEvent({
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_offline_1' },
    })
    writeEvent({
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_offline_1' },
    })
    writeEvent({
      type: 'response.output_text.delta',
      item_id: 'msg_offline_1',
      delta: 'after pause',
    })
    writeEvent({
      type: 'response.output_item.done',
      item: { type: 'message', id: 'msg_offline_1' },
    })
    writeEvent({
      type: 'response.completed',
      response: {
        id: 'resp-offline-thinking-mock',
        object: 'response',
        model,
        status: 'completed',
        output: [],
        usage: { input_tokens: 11, output_tokens: 5 },
      },
    })
    response.end()
  }, delayMs).unref()
}

function writeOpenAiMidstreamError(response, model) {
  const base = {
    id: 'chatcmpl-offline-midstream-error',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  }
  const chunks = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: 'partial reply' }, finish_reason: null }],
    },
  ]

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end([
    'event: error',
    `data: ${JSON.stringify({
      error: {
        message: 'synthetic upstream ECONNRESET aborted',
        type: 'upstream_stream_error',
        code: 'ECONNRESET',
        status: 502,
      },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'))
}

async function startMockUpstream() {
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)

    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid JSON from Chat2API' } }))
      return
    }

    calls.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body,
    })

    if (
      request.method !== 'POST'
      || !['/v1/chat/completions', '/v1/responses'].includes(request.url)
    ) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Mock route not found' } }))
      return
    }

    if (request.url === '/v1/responses') {
      if (body.stream) {
        writeOpenAiResponsesDelayedStream(response, body.model || MOCK_UPSTREAM_MODEL)
        return
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        id: 'resp-offline-thinking-mock',
        object: 'response',
        model: body.model || MOCK_UPSTREAM_MODEL,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'offline response reply' }] }],
        usage: { input_tokens: 11, output_tokens: 5 },
      }))
      return
    }

    const text = messageText(body.messages)
    if (text.includes('UPSTREAM_ERROR')) {
      response.writeHead(429, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        error: {
          message: 'synthetic offline rate limit',
          type: 'rate_limit_error',
          code: 'rate_limit',
        },
      }))
      return
    }

    if (body.stream && text.includes('MIDSTREAM_ERROR')) {
      writeOpenAiMidstreamError(response, body.model || MIDSTREAM_ERROR_MODEL)
      return
    }

    if (body.stream && text.includes('HEARTBEAT_CASE')) {
      writeOpenAiDelayedStream(response, body.model || MOCK_UPSTREAM_MODEL)
      return
    }

    if (body.stream) {
      writeOpenAiStream(response, body.model || MOCK_UPSTREAM_MODEL)
      return
    }

    const responseBody = text.includes('TOOL_CASE')
      ? openAiToolResponse(body.model || MOCK_UPSTREAM_MODEL)
      : openAiResponse(body.model || MOCK_UPSTREAM_MODEL, 'offline non-stream reply')

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(responseBody))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  return { server, port: address.port, calls }
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event
      const dataLines = []
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
      }

      const rawData = dataLines.join('\n')
      let data = rawData
      try {
        data = JSON.parse(rawData)
      } catch {
        // Keep non-JSON markers available to assertions.
      }
      return { event, data, rawData }
    })
}

function createLiteLlmConfig(chat2ApiPort, chat2ApiKey, mockPort) {
  return [
    'model_list:',
    `  - model_name: ${JSON.stringify(MIDSTREAM_ERROR_MODEL)}`,
    '    litellm_params:',
    `      model: ${JSON.stringify(`openai/${MIDSTREAM_ERROR_MODEL}`)}`,
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${mockPort}/v1`)}`,
    `      api_key: ${JSON.stringify(MOCK_UPSTREAM_KEY)}`,
    '      num_retries: 0',
    `  - model_name: ${JSON.stringify(ADAPTIVE_MODEL_ALIAS)}`,
    '    litellm_params:',
    `      model: ${JSON.stringify(`openai/${ADAPTIVE_MODEL_ALIAS}`)}`,
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${mockPort}/v1`)}`,
    `      api_key: ${JSON.stringify(MOCK_UPSTREAM_KEY)}`,
    '      num_retries: 0',
    '      allowed_openai_params: ["reasoning_effort"]',
    '    model_info:',
    '      supports_reasoning: true',
    `  - model_name: ${JSON.stringify(RESPONSES_MODEL_ALIAS)}`,
    '    litellm_params:',
    `      model: ${JSON.stringify(`openai/${RESPONSES_MODEL_ALIAS}`)}`,
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${mockPort}/v1`)}`,
    `      api_key: ${JSON.stringify(MOCK_UPSTREAM_KEY)}`,
    '      num_retries: 0',
    '      allowed_openai_params: ["reasoning_effort"]',
    '    model_info:',
    '      supports_reasoning: true',
    '  - model_name: "*"',
    '    litellm_params:',
    '      model: "openai/*"',
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${chat2ApiPort}/v1`)}`,
    `      api_key: ${JSON.stringify(chat2ApiKey)}`,
    '      num_retries: 0',
    '      allowed_openai_params: ["reasoning_effort"]',
    '      timeout: 20',
    'general_settings:',
    `  master_key: ${JSON.stringify(LITELLM_MASTER_KEY)}`,
    '  cancel_on_disconnect: true',
    'router_settings:',
    '  num_retries: 0',
    'litellm_settings:',
    '  drop_params: false',
    '  set_verbose: false',
    // LiteLLM 1.93.0 routes openai/* deployments to /v1/responses by default.
    // Chat2API exposes Chat Completions, so opt into the documented fallback.
    '  use_chat_completions_url_for_anthropic_messages: true',
    '',
  ].join('\n')
}

test('patched LiteLLM v1.93.0 exposes Anthropic Messages over Chat2API completely offline', {
  timeout: 240_000,
}, async (t) => {
  const repoRoot = process.cwd()
  const serverEntry = path.join(repoRoot, 'out-server/server/index.js')
  assert.ok(
    fs.existsSync(serverEntry),
    'Missing out-server/server/index.js; run npm run build:server first',
  )

  try {
    await execFileAsync('docker', ['image', 'inspect', LITELLM_BASE_IMAGE], {
      windowsHide: true,
      timeout: 15_000,
    })
  } catch (error) {
    throw new Error(
      `The exact offline image is required. Run: docker pull ${LITELLM_BASE_IMAGE}`,
      { cause: error },
    )
  }

  await execFileAsync('docker', [
    'build',
    '--pull=false',
    '--build-arg', `LITELLM_BASE_IMAGE=${LITELLM_BASE_IMAGE}`,
    '--file', 'deploy/litellm/Dockerfile',
    '--tag', LITELLM_IMAGE,
    'deploy/litellm',
  ], {
    cwd: repoRoot,
    windowsHide: true,
    timeout: 120_000,
  })

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-litellm-integration-'))
  const chat2ApiDataDir = path.join(tempRoot, 'chat2api-data')
  const liteLlmConfigPath = path.join(tempRoot, 'litellm-config.yaml')
  fs.mkdirSync(chat2ApiDataDir, { recursive: true })

  const [chat2ApiPort, liteLlmPort] = await reservePorts(2)
  const containerName = `chat2api-litellm-test-${process.pid}-${Date.now()}`
  let mock
  let chat2ApiChild
  let liteLlmChild

  t.after(async () => {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName], {
        windowsHide: true,
        timeout: 15_000,
      })
    } catch {
      // The --rm container may already be gone.
    }

    await stopChild(liteLlmChild)
    await stopChild(chat2ApiChild)
    if (mock?.server.listening) {
      await new Promise((resolve) => mock.server.close(resolve))
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  mock = await startMockUpstream()

  chat2ApiChild = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT2API_HOST: '0.0.0.0',
      CHAT2API_PORT: String(chat2ApiPort),
      CHAT2API_DATA_DIR: chat2ApiDataDir,
      CHAT2API_ENABLE_MANAGEMENT_API: 'true',
      CHAT2API_MANAGEMENT_SECRET: MANAGEMENT_SECRET,
      CHAT2API_ENABLE_API_KEY: 'false',
      CHAT2API_LOG_LEVEL: 'error',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chat2ApiOutput = captureOutput(chat2ApiChild)
  const chat2ApiBaseUrl = `http://127.0.0.1:${chat2ApiPort}`
  await waitForHttp({
    url: `${chat2ApiBaseUrl}/health`,
    child: chat2ApiChild,
    output: chat2ApiOutput,
    timeoutMs: 15_000,
    serviceName: 'Chat2API',
  })

  const providerResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/providers`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      id: MOCK_PROVIDER_ID,
      name: 'LiteLLM Offline OpenAI Mock',
      type: 'custom',
      authType: 'token',
      apiEndpoint: `http://127.0.0.1:${mock.port}`,
      chatPath: '/v1/chat/completions',
      headers: { 'X-Offline-Integration': 'litellm' },
      supportedModels: [MOCK_MODEL_ALIAS],
      modelMappings: { [MOCK_MODEL_ALIAS]: MOCK_UPSTREAM_MODEL },
      credentialFields: [{
        name: 'token',
        label: 'Token',
        type: 'password',
        required: true,
      }],
    }),
  })
  assert.equal(providerResult.response.status, 201, providerResult.text)

  const accountResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/accounts`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      providerId: MOCK_PROVIDER_ID,
      name: 'LiteLLM Offline Mock Account',
      credentials: { token: MOCK_UPSTREAM_KEY },
    }),
  })
  assert.equal(accountResult.response.status, 201, accountResult.text)

  const syntheticMappingResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/model-mappings`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      requestModel: SYNTHETIC_CLIENT_MODEL,
      actualModel: MOCK_MODEL_ALIAS,
      preferredProviderId: MOCK_PROVIDER_ID,
    }),
  })
  assert.equal(syntheticMappingResult.response.status, 201, syntheticMappingResult.text)

  const keyResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/api-keys`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({ name: 'LiteLLM offline integration' }),
  })
  assert.equal(keyResult.response.status, 201, keyResult.text)
  const chat2ApiKey = keyResult.body?.data?.key
  assert.match(chat2ApiKey || '', /^sk-mgmt-/)

  const configResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/config`, {
    method: 'PUT',
    headers: managementHeaders(),
    body: JSON.stringify({
      enableApiKey: true,
      retryCount: 0,
      requestTimeout: 20_000,
    }),
  })
  assert.equal(configResult.response.status, 200, configResult.text)

  fs.writeFileSync(
    liteLlmConfigPath,
    createLiteLlmConfig(chat2ApiPort, chat2ApiKey, mock.port),
    'utf8',
  )

  liteLlmChild = spawn('docker', [
    'run',
    '--rm',
    '--pull=never',
    '--name', containerName,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${liteLlmPort}:4000`,
    '-v', `${liteLlmConfigPath}:/app/config.yaml:ro`,
    '-e', 'LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS=100',
    '-e', 'LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY=true',
    LITELLM_IMAGE,
    '--config', '/app/config.yaml',
    '--host', '0.0.0.0',
    '--port', '4000',
    '--num_workers', '1',
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const liteLlmOutput = captureOutput(liteLlmChild)
  const liteLlmBaseUrl = `http://127.0.0.1:${liteLlmPort}`
  await waitForHttp({
    url: `${liteLlmBaseUrl}/health/liveliness`,
    child: liteLlmChild,
    output: liteLlmOutput,
    timeoutMs: 60_000,
    serviceName: 'LiteLLM',
  })

  await t.test('loads zero retries into the live LiteLLM router', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/router/settings`, {
      headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
    })
    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body?.current_values?.num_retries, 0, result.text)
  })

  await t.test('enforces LiteLLM and Chat2API API keys', async () => {
    const callsBefore = mock.calls.length
    const missingKey = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicRequest()),
    })
    assert.equal(missingKey.response.status, 401, missingKey.text)
    assert.equal(typeof missingKey.body?.error?.message, 'string')

    const invalidKey = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders('sk-invalid-offline-key'),
      body: JSON.stringify(anthropicRequest()),
    })
    // With only general_settings.master_key and no database, LiteLLM 1.93.0
    // treats an unknown key as a virtual-key lookup and reports no_db_connection
    // instead of returning the 401 used for a missing key.
    assert.equal(invalidKey.response.status, 400, invalidKey.text)
    assert.equal(invalidKey.body?.error?.type, 'no_db_connection')
    assert.equal(invalidKey.body?.error?.code, '400')
    assert.equal(mock.calls.length, callsBefore, 'Authentication failures must not reach upstream')

    const directMissingKey = await fetch(`${chat2ApiBaseUrl}/v1/models`)
    assert.equal(directMissingKey.status, 401)
    const directValidKey = await fetch(`${chat2ApiBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${chat2ApiKey}` },
    })
    assert.equal(directValidKey.status, 200)
  })

  await t.test('maps a client connectivity probe through Chat2API model mappings', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: SYNTHETIC_CLIENT_MODEL,
        messages: [{ role: 'user', content: 'SYNTHETIC_CONNECTIVITY_CHECK' }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.type, 'message')
    assert.equal(result.body.model, SYNTHETIC_CLIENT_MODEL)
    assert.equal(mock.calls.at(-1)?.body?.model, MOCK_UPSTREAM_MODEL)
  })

  await t.test('converts a non-streaming Anthropic message through both proxies', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        system: 'You are an offline integration test.',
        messages: [{ role: 'user', content: 'NON_STREAM_CASE' }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.type, 'message')
    assert.equal(result.body.role, 'assistant')
    assert.equal(result.body.model, MOCK_MODEL_ALIAS)
    assert.equal(result.body.content?.[0]?.type, 'text')
    assert.equal(result.body.content?.[0]?.text, 'offline non-stream reply')
    assert.equal(result.body.stop_reason, 'end_turn')
    assert.equal(result.body.usage?.input_tokens, 11)
    assert.equal(result.body.usage?.output_tokens, 5)

    const call = mock.calls.at(-1)
    assert.equal(call.url, '/v1/chat/completions')
    assert.equal(call.headers.authorization, `Bearer ${MOCK_UPSTREAM_KEY}`)
    assert.equal(call.headers['x-offline-integration'], 'litellm')
    assert.equal(call.body.model, MOCK_UPSTREAM_MODEL)
    assert.equal(call.body.stream, false)
    assert.ok(call.body.messages.some((message) => message.role === 'system'))
  })

  await t.test('emits Anthropic streaming SSE events', async () => {
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        stream: true,
        messages: [{ role: 'user', content: 'STREAM_CASE' }],
      })),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)

    const events = parseSse(text)
    const eventTypes = events.map((event) => event.event || event.data?.type)
    assert.ok(eventTypes.includes('message_start'), text)
    assert.ok(eventTypes.includes('content_block_start'), text)
    assert.ok(eventTypes.includes('content_block_delta'), text)
    assert.ok(eventTypes.includes('message_delta'), text)
    assert.ok(eventTypes.includes('message_stop'), text)

    const streamedText = events
      .filter((event) => (event.event || event.data?.type) === 'content_block_delta')
      .map((event) => event.data?.delta?.text || '')
      .join('')
    assert.equal(streamedText, 'offline stream reply')
  })

  await t.test('emits Anthropic ping events while an upstream stream is quiet', async () => {
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: ADAPTIVE_MODEL_ALIAS,
        stream: true,
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'HEARTBEAT_CASE' }],
      })),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)

    const call = mock.calls.at(-1)
    assert.equal(call?.url, '/v1/chat/completions', JSON.stringify(call))

    const events = parseSse(text)
    const pingEvents = events.filter((event) => event.event === 'ping')
    assert.ok(pingEvents.length >= 1, text)
    assert.ok(pingEvents.every((event) => event.data?.type === 'ping'), text)

    const streamedText = events
      .filter((event) => (event.event || event.data?.type) === 'content_block_delta')
      .map((event) => event.data?.delta?.text || '')
      .join('')
    assert.equal(streamedText, 'before pause after pause')
    assert.ok(
      events.findIndex((event) => event.event === 'ping')
        < events.findIndex((event) => (event.event || event.data?.type) === 'message_stop'),
      text,
    )
  })

  await t.test('emits Anthropic ping events for thinking Responses streams', async () => {
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: RESPONSES_MODEL_ALIAS,
        max_tokens: 256,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 64 },
        messages: [{ role: 'user', content: 'RESPONSES_HEARTBEAT_CASE' }],
      })),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)

    const call = mock.calls.at(-1)
    assert.equal(call?.url, '/v1/responses', JSON.stringify(call))

    const events = parseSse(text)
    const pingEvents = events.filter((event) => event.event === 'ping')
    assert.ok(pingEvents.length >= 1, text)
    assert.ok(pingEvents.every((event) => event.data?.type === 'ping'), text)
    assert.ok(
      events.some((event) => (
        event.event === 'content_block_delta'
        && event.data?.delta?.type === 'thinking_delta'
      )),
      text,
    )
    assert.ok(
      events.some((event) => (
        event.event === 'content_block_delta'
        && event.data?.delta?.text === 'after pause'
      )),
      text,
    )
    assert.equal(events.at(-1)?.event, 'message_stop', text)
  })

  await t.test('terminates mid-stream provider failures with an Anthropic error event', async () => {
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: MIDSTREAM_ERROR_MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'MIDSTREAM_ERROR' }],
      })),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)

    const events = parseSse(text)
    const errorEvents = events.filter((event) => event.event === 'error')
    assert.equal(errorEvents.length, 1, text)
    assert.equal(events.at(-1)?.event, 'error', text)
    assert.equal(errorEvents[0].data?.type, 'error', text)
    assert.equal(errorEvents[0].data?.error?.type, 'api_error', text)
    assert.match(errorEvents[0].data?.error?.message || '', /ECONNRESET|aborted/i)
    assert.ok(
      events.some((event) => (
        event.event === 'content_block_delta'
        && event.data?.delta?.text === 'partial reply'
      )),
      text,
    )
  })

  await t.test('maps tools and a forced tool_choice to Anthropic tool_use', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [{ role: 'user', content: 'TOOL_CASE: weather in Shanghai' }],
        tools: [{
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        }],
        tool_choice: { type: 'tool', name: 'get_weather' },
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.stop_reason, 'tool_use')
    const toolUse = result.body.content?.find((block) => block.type === 'tool_use')
    assert.ok(toolUse, result.text)
    assert.equal(toolUse.id, 'call_offline_weather_1')
    assert.equal(toolUse.name, 'get_weather')
    assert.deepEqual(toolUse.input, { city: 'Shanghai' })

    const call = mock.calls.at(-1)
    assert.equal(call.body.tools?.[0]?.function?.name, 'get_weather')
    assert.deepEqual(call.body.tool_choice, {
      type: 'function',
      function: { name: 'get_weather' },
    })
  })

  await t.test('maps Anthropic tool_result continuation messages to OpenAI tool messages', async () => {
    const toolUseId = 'call_offline_weather_previous'
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [
          { role: 'user', content: 'Check the weather with the available tool.' },
          {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: toolUseId,
              name: 'get_weather',
              input: { city: 'Shanghai' },
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: 'Sunny, 25 C',
            }],
          },
        ],
        tools: [{
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.content?.[0]?.text, 'offline non-stream reply')

    const call = mock.calls.at(-1)
    const assistantMessage = call.body.messages.find((message) =>
      message.role === 'assistant' && Array.isArray(message.tool_calls)
    )
    assert.ok(assistantMessage, JSON.stringify(call.body.messages))
    assert.equal(assistantMessage.tool_calls[0]?.id, toolUseId)
    assert.equal(assistantMessage.tool_calls[0]?.type, 'function')
    assert.equal(assistantMessage.tool_calls[0]?.function?.name, 'get_weather')
    assert.deepEqual(
      JSON.parse(assistantMessage.tool_calls[0]?.function?.arguments || '{}'),
      { city: 'Shanghai' },
    )

    const toolMessage = call.body.messages.find((message) => message.role === 'tool')
    assert.ok(toolMessage, JSON.stringify(call.body.messages))
    assert.equal(toolMessage.tool_call_id, toolUseId)
    assert.equal(toolMessage.content, 'Sunny, 25 C')
  })

  await t.test('counts Anthropic text, system, and tools locally without an upstream probe', async () => {
    const callsBefore = mock.calls.length
    const baseline = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        messages: [{ role: 'user', content: 'Count these tokens without an upstream call.' }],
      }),
    })

    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        system: 'Offline token counting system prompt.',
        messages: [{ role: 'user', content: 'Count these tokens without an upstream call.' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        }],
      }),
    })

    assert.equal(baseline.response.status, 200, baseline.text)
    assert.equal(result.response.status, 200, result.text)
    assert.equal(Number.isInteger(baseline.body?.input_tokens), true, baseline.text)
    assert.equal(Number.isInteger(result.body?.input_tokens), true, result.text)
    assert.ok(result.body.input_tokens > baseline.body.input_tokens, result.text)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('counts Anthropic base64 images locally', async () => {
    const callsBefore = mock.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: ONE_PIXEL_PNG_BASE64,
            },
          }],
        }],
      }),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(Number.isInteger(result.body?.input_tokens), true, result.text)
    assert.ok(result.body.input_tokens > 0, result.text)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('records the LiteLLM v1.93.0 upstream error envelope', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [{ role: 'user', content: 'UPSTREAM_ERROR' }],
      })),
    })

    assert.equal(result.response.status, 429, result.text)
    // LiteLLM 1.93.0 maps successful /v1/messages responses to Anthropic but
    // its generic ProxyException handler still emits this OpenAI-style error
    // envelope. Keep the black-box assertion explicit so a future upgrade that
    // fixes the wire format is visible rather than silently changing behavior.
    assert.deepEqual(Object.keys(result.body), ['error'])
    assert.equal(result.body.error?.type, 'throttling_error', result.text)
    assert.equal(result.body.error?.code, '429', result.text)
    assert.match(result.body.error?.message || '', /synthetic offline rate limit/i)
  })

  t.diagnostic(`LiteLLM image: ${LITELLM_IMAGE}`)
  t.diagnostic(`Offline OpenAI upstream calls: ${mock.calls.length}`)
  t.diagnostic('LiteLLM 1.93.0 without a DB returns 400/no_db_connection for unknown keys')
  t.diagnostic('LiteLLM 1.93.0 emits an OpenAI-style error envelope for /v1/messages upstream errors')
})
