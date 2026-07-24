import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)

function adapterWithMatcher(name, matches = false) {
  const Adapter = class {}
  Adapter[name] = () => matches
  return Adapter
}

function loadRequestForwarder(overrides = {}) {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const StreamHandler = class {}
  const localModules = {
    axios: { create: () => ({}) },
    http2: {},
    '../store/types': {},
    './types': {},
    './status': { proxyStatusManager: {} },
    '../store/store': {
      storeManager: {
        getConfig: () => ({
          retryCount: 3,
          contextManagement: { enabled: false },
          toolCallingConfig: {},
        }),
      },
    },
    './adapters/deepseek': { DeepSeekAdapter: adapterWithMatcher('isDeepSeekProvider') },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: StreamHandler },
    './adapters/glm': {
      GLMAdapter: adapterWithMatcher('isGLMProvider'),
      GLMStreamHandler: StreamHandler,
    },
    './adapters/kimi': {
      KimiAdapter: adapterWithMatcher('isKimiProvider'),
      KimiStreamHandler: StreamHandler,
    },
    './adapters/mimo': {
      MimoAdapter: adapterWithMatcher('isMimoProvider'),
      MimoStreamHandler: StreamHandler,
    },
    './adapters/qwen': {
      QwenAdapter: adapterWithMatcher('isQwenProvider'),
      QwenStreamHandler: StreamHandler,
    },
    './adapters/qwen-ai': {
      describeErrorForLog: error => error?.message || String(error),
      QWEN_AI_STREAM_FAILURE_EVENT: 'qwen-ai-stream-failure',
      createQwenAiResumableStream: stream => stream,
      QwenAiAdapter: overrides.QwenAiAdapter || adapterWithMatcher('isQwenAiProvider', true),
      QwenAiStreamHandler: overrides.QwenAiStreamHandler || StreamHandler,
    },
    './adapters/zai': {
      ZaiAdapter: adapterWithMatcher('isZaiProvider'),
      ZaiStreamHandler: StreamHandler,
    },
    './adapters/minimax': {
      MiniMaxAdapter: adapterWithMatcher('isMiniMaxProvider'),
      MiniMaxStreamHandler: StreamHandler,
    },
    './adapters/perplexity': { PerplexityAdapter: adapterWithMatcher('isPerplexityProvider') },
    './adapters/perplexity-stream': { PerplexityStreamHandler: StreamHandler },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class {} },
    './qwenAiRequestGovernor': {
      qwenAiRequestGovernor: { run: (_accountId, operation) => operation() },
    },
    './utils/validatedSseStream': {
      BufferedSseError: class BufferedSseError extends Error {},
      bufferValidatedSseStream: async stream => stream,
    },
    './utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: () => undefined,
    },
    './sessionManager': {
      sessionManager: { shouldDeleteAfterChat: () => true },
    },
    './services/contextManagementService': {
      createContextManagementService: () => ({ process: async messages => ({ messages }) }),
    },
  }

  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected forwarder recovery test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports.RequestForwarder
}

function createHarness(results) {
  const RequestForwarder = loadRequestForwarder()
  const forwarder = new RequestForwarder()
  const attempts = []

  forwarder.delay = async () => true
  forwarder.doForward = async (...args) => {
    attempts.push(args.at(-1))
    const result = results[attempts.length - 1]
    if (result instanceof Error) throw result
    return result
  }

  const execute = request => forwarder.forwardChatCompletion(
    request,
    { id: 'account-1' },
    { id: 'provider-1', apiEndpoint: 'https://provider.invalid' },
    'model-1',
    { signal: new AbortController().signal },
  )

  return { attempts, execute }
}

test('managed-tool buffered stream validation failure recovers once before bytes are committed', async () => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  try {
    const { attempts, execute } = createHarness([
      {
        success: false,
        status: 502,
        error: 'buffered upstream stream ended early',
        errorCode: 'qwen_ai_stream_incomplete',
        retryable: false,
        recoveryHint: 'managed_tool_stream_validation',
      },
      { success: true, status: 200, body: { choices: [] } },
    ])

    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, true)
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].qwenAiRecoveryBypassAccountInterval, false)
    assert.equal(attempts[1].qwenAiRecoveryBypassAccountInterval, true)
  } finally {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  }
})

test('managed-tool streams stay live and do not retry when buffering is disabled', async () => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  const previousRetries = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '3'
  try {
    const { attempts, execute } = createHarness([{
      success: false,
      status: 502,
      error: 'late managed stream failure',
      recoveryHint: 'managed_tool_stream_validation',
    }, { success: true, status: 200, body: { choices: [] } }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  } finally {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
    if (previousRetries === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previousRetries
  }
})

test('ordinary streams and unrelated failures do not use managed-tool recovery', async () => {
  const scenarios = [
    {
      request: { model: 'model-1', messages: [], stream: true },
      failure: { success: false, status: 502, error: 'stream ended early' },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: { success: false, status: 429, error: 'queue full', retryable: false },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: {
        success: false,
        status: 504,
        error: 'response timed out',
        retryable: false,
        recoveryHint: 'managed_tool_stream_validation',
      },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: {
        success: false,
        status: 403,
        error: 'risk control',
        errorCode: 'qwen_ai_risk_control',
        retryable: false,
      },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: { success: false, status: 499, error: 'client disconnected', retryable: false },
    },
  ]

  for (const { request, failure } of scenarios) {
    const { attempts, execute } = createHarness([failure])
    const result = await execute(request)
    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  }
})

test('outer Qwen forwarding preserves account-neutral failures from results and thrown errors', async () => {
  const failures = [
    {
      success: false,
      status: 502,
      error: 'account-neutral result',
      retryable: false,
      accountFault: false,
    },
    Object.assign(new Error('account-neutral exception'), {
      status: 502,
      retryable: false,
      accountFault: false,
    }),
  ]

  for (const failure of failures) {
    const { attempts, execute } = createHarness([failure])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
    })

    assert.equal(result.success, false)
    assert.equal(result.status, 502)
    assert.equal(result.accountFault, false)
    assert.equal(attempts.length, 1)
  }
})

test('outer Qwen forwarding clears account classification when the client aborts', async () => {
  for (const upstreamStatus of [502, 499]) {
    const RequestForwarder = loadRequestForwarder()
    const forwarder = new RequestForwarder()
    const controller = new AbortController()

    forwarder.doForward = async () => {
      controller.abort()
      return {
        success: false,
        status: upstreamStatus,
        error: 'protocol failure overtaken by client cancellation',
        retryable: false,
        accountFault: false,
      }
    }

    const result = await forwarder.forwardChatCompletion(
      { model: 'model-1', messages: [], stream: true },
      { id: 'account-1' },
      { id: 'provider-1', apiEndpoint: 'https://provider.invalid' },
      'model-1',
      { signal: controller.signal },
    )

    assert.equal(result.success, false)
    assert.equal(result.status, 499)
    assert.equal(result.accountFault, undefined)
  }
})

test('an explicit zero retry count disables managed-tool recovery', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '0'
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  try {
    const { attempts, execute } = createHarness([{
      success: false,
      status: 502,
      error: 'buffered upstream stream ended early',
      recoveryHint: 'managed_tool_stream_validation',
    }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previous
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  }
})

test('an explicit retry count does not enable ordinary Qwen stream retries', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '1'
  try {
    const { attempts, execute } = createHarness([{
      success: false,
      status: 502,
      error: 'ordinary upstream stream ended early',
    }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
    })

    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previous
  }
})

test('live managed-tool forwarding deletes its temporary chat only after stream termination', async () => {
  const output = new PassThrough()
  const deleteCalls = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-1',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: true },
  })

  const resultPromise = forwarder.forwardQwenAi(
    {
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )

  const firstChunk = 'data: {"choices":[{"delta":{"content":"ready"}}]}\n\n'
  output.write(firstChunk)
  const result = await resultPromise

  assert.equal(result.success, true)
  assert.equal(result.stream, output)
  assert.deepEqual(deleteCalls, [])

  const received = []
  output.on('data', chunk => received.push(chunk))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Buffer.concat(received).toString(), firstChunk)

  const finished = once(output, 'finish')
  output.end('data: [DONE]\n\n')
  await finished
  assert.deepEqual(deleteCalls, ['temporary-chat-1'])

  output.destroy()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleteCalls, ['temporary-chat-1'])
})

test('Qwen AI preflight releases a quiet stream after the configured hold', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = '10'
  const output = new PassThrough()

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-preflight',
        parentId: null,
      }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  try {
    const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
    const forwarder = new RequestForwarder()
    forwarder.transformRequestForPromptToolUse = request => ({
      messages: request.messages,
      plan: { shouldParseResponse: false },
    })

    const startedAt = Date.now()
    const result = await forwarder.forwardQwenAi(
      { model: 'model-1', messages: [], stream: true },
      { id: 'account-1' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'model-1',
      Date.now(),
      { signal: new AbortController().signal },
    )

    assert.equal(result.success, true)
    assert.equal(result.stream, output)
    assert.ok(Date.now() - startedAt < 500, 'quiet preflight should be bounded')
    output.end('data: [DONE]\n\n')
  } finally {
    output.destroy()
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
    else process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = previous
  }
})

test('Qwen AI preflight does not treat an empty readable event as output', async () => {
  const output = new PassThrough()
  const deleteCalls = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-empty',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const resultPromise = forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  setImmediate(() => output.end())

  const result = await resultPromise
  assert.equal(result.success, false)
  assert.equal(result.status, 502)
  assert.equal(result.errorCode, 'qwen_ai_stream_incomplete')
  assert.deepEqual(deleteCalls, ['temporary-chat-empty'])
  output.destroy()
})

test('Qwen AI forwarding returns a structured failure before the first visible stream event', async () => {
  const output = new PassThrough()
  const deleteCalls = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-capacity',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const resultPromise = forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  const capacityError = Object.assign(new Error('Qwen AI capacity limit'), {
    status: 429,
    code: 'qwen_ai_capacity_limit',
    retryable: false,
  })
  output.qwenAiFailure = capacityError
  output.emit('qwen-ai-stream-failure', capacityError)
  output.end()

  const result = await resultPromise
  assert.equal(result.success, false)
  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'qwen_ai_capacity_limit')
  assert.equal(result.retryable, false)
  assert.equal(result.stream, undefined)
  assert.deepEqual(deleteCalls, ['temporary-chat-capacity'])
})
