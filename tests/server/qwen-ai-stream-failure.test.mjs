import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)

function loadQwenAiStreamHandler(overrides = {}) {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const localModules = {
    '../../store/types': {},
    '../promptToolUse': {
      hasToolUse: () => false,
      parseToolUse: () => [],
    },
    './qwen-ai-token-refresh': {
      QwenAiTokenRefresher: class {},
    },
    './qwen-ai-files': {
      QwenAiFileUploader: class {},
      QWEN_AI_DOCUMENT_EVIDENCE_MARKER: '[Attached document evidence]',
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({
        id,
        model,
        object: 'chat.completion.chunk',
        created,
      }),
    },
    '../utils/errors': {
      isClientCancellationError: error => Boolean(
        error && (
          error.name === 'AbortError'
          || error.name === 'CanceledError'
          || error.code === 'ABORT_ERR'
          || error.code === 'ERR_CANCELED'
          || /client disconnected|downstream stream closed|request aborted by (?:the )?client/i.test(error.message || '')
        ),
      ),
      sanitizeForwardedErrorHeaders: () => undefined,
    },
    '../toolCalling/ToolStreamParser': {
      ToolStreamParser: overrides.ToolStreamParser || class {},
    },
    '../toolCalling/streamValidationPolicy': {
      getToolStreamValidationFailure: overrides.getToolStreamValidationFailure || (() => undefined),
    },
    './qwen-ai-native-tools': {
      isCompleteJsonText: () => true,
      mergeNativeToolArguments: (_current, next) => next,
      normalizeNativeFunctionCallDelta: () => [],
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected Qwen AI stream test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

test('Qwen AI stream exposes an idle failure to the proxy route', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})

  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 20,
  })
  const ended = once(output, 'end')
  output.resume()

  const failure = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream failure was not emitted')), 500)
    output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
      clearTimeout(timer)
      resolve(error)
    })
  })

  assert.match(failure.message, /idle for more than 1s/)
  assert.equal(failure.status, 504)
  assert.equal(failure.retryable, false)
  assert.equal(output.qwenAiFailure, failure)
  await ended
  upstream.destroy()
})

test('Qwen AI stream classifies an in-band captcha envelope as risk control', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::captcha required'],
    data: { url: 'https://chat.qwen.ai/punish?action=captcha&x5secdata=secret' },
  })}\n\n`)

  const [failure] = await failurePromise
  assert.equal(failure.status, 403)
  assert.equal(failure.code, 'qwen_ai_risk_control')
  assert.match(failure.message, /FAIL_SYS_USER_VALIDATE/)
  assert.doesNotMatch(failure.message, /x5secdata=secret/)
  await ended
  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"status":403/)
  assert.match(serialized, /"retryable":false/)
})

test('Qwen AI stream does not confuse token usage 429 with an HTTP rate limit', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failureCount = 0
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        role: 'assistant',
        content: 'normal answer',
        phase: 'answer',
        status: 'typing',
      },
    }],
    usage: {
      output_tokens_details: {
        reasoning_tokens: 10_954,
        text_tokens: 429,
      },
    },
  })}\n\n`)
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.equal(failureCount, 0)
  assert.equal(output.qwenAiFailure, undefined)
  assert.match(Buffer.concat(chunks).toString(), /normal answer/)
})

test('Qwen AI stream preserves an explicit 429 error envelope', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    status: 429,
    error: { message: 'too many requests' },
  })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 429)
  assert.equal(failure.retryable, false)
  assert.match(Buffer.concat(chunks).toString(), /"status":429/)
})

test('Qwen AI stream classifies a structured quota-limit envelope as 429', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    error: {
      code: 'quota_limit',
      details: 'The service is busy. Please try again later.',
    },
    response_id: 'provider-response-id',
    response_index: 0,
  })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 429)
  assert.equal(failure.code, 'qwen_ai_capacity_limit')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /service is busy/i)
  assert.match(Buffer.concat(chunks).toString(), /"status":429/)
})

test('Qwen AI non-stream parsing classifies a structured quota-limit envelope as 429', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model')
  const result = handler.handleNonStream(upstream)

  upstream.end(`data: ${JSON.stringify({
    error: {
      code: 'quota_limit',
      details: 'The service is busy. Please try again later.',
    },
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 429
    && error.code === 'qwen_ai_capacity_limit'
    && error.retryable === false
  ))
})

test('Qwen AI stream classifies a code-only risk envelope as 403', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  output.resume()

  upstream.end(`data: ${JSON.stringify({ error: { code: 'FAIL_SYS_USER_VALIDATE' } })}\n\n`)
  const [failure] = await failurePromise

  assert.equal(failure.status, 403)
  assert.equal(failure.code, 'qwen_ai_risk_control')
})

test('Qwen AI stream preserves generic structured error metadata', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({
    error: {
      status: 503,
      message: 'upstream unavailable',
      type: 'provider_error',
      param: 'model',
      code: 'upstream_unavailable',
      retryable: true,
    },
  })}\n\n`)
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 503)
  assert.equal(failure.type, 'provider_error')
  assert.equal(failure.param, 'model')
  assert.equal(failure.code, 'upstream_unavailable')
  assert.equal(failure.retryable, true)

  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"status":503/)
  assert.match(serialized, /"type":"provider_error"/)
  assert.match(serialized, /"param":"model"/)
  assert.match(serialized, /"code":"upstream_unavailable"/)
  assert.match(serialized, /"retryable":true/)
})

test('Qwen AI stream classifies string and array error envelopes', async () => {
  const cases = [
    { envelope: { error: 'too many requests' }, expectedStatus: 429 },
    { envelope: { errors: ['captcha required'] }, expectedStatus: 403 },
    {
      envelope: {
        choices: [{ delta: { content: 'partial answer' } }],
        error: 'rate limit exceeded',
      },
      expectedStatus: 429,
    },
  ]

  for (const { envelope, expectedStatus } of cases) {
    const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
    const upstream = new PassThrough()
    upstream.on('error', () => {})
    const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
    const output = await handler.handleStream(upstream)
    const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
    output.resume()
    const ended = once(output, 'end')

    upstream.write(`data: ${JSON.stringify(envelope)}\n\n`)

    const [failure] = await failurePromise
    await ended
    assert.equal(failure.status, expectedStatus)
  }
})

test('Qwen AI stream ignores rate-limit words on an ordinary completion envelope', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  let failureCount = 0
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.resume()
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        content: 'normal answer',
        phase: 'answer',
        status: 'typing',
      },
    }],
    message: 'rate limit documentation example',
  })}\n\n`)
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.equal(failureCount, 0)
  assert.equal(output.qwenAiFailure, undefined)
})

test('Qwen AI stream ignores numeric 429 metadata on an ordinary completion envelope', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  let failureCount = 0
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.resume()
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    code: 429,
    choices: [{ delta: { phase: 'answer', status: 'typing', content: 'normal' } }],
    usage: { output_tokens_details: { text_tokens: 429 } },
  })}\n\n`)
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.equal(failureCount, 0)
  assert.equal(output.qwenAiFailure, undefined)
})

test('Qwen AI stream classifies a plain-text error event', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  output.resume()
  const ended = once(output, 'end')

  upstream.end('event: error\ndata: too many requests\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 429)
  assert.equal(failure.retryable, false)
})

test('Qwen AI stream maps malformed JSON and upstream transport aborts to 502', async () => {
  for (const failUpstream of [
    upstream => upstream.end('data: {not-json}\n\n'),
    upstream => upstream.destroy(new Error('aborted')),
  ]) {
    const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
    const upstream = new PassThrough()
    upstream.on('error', () => {})
    const handler = new QwenAiStreamHandler('test-model')
    const output = await handler.handleStream(upstream)
    const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
    output.resume()

    failUpstream(upstream)
    const [failure] = await failurePromise

    assert.equal(failure.status, 502)
    assert.equal(failure.retryable, false)
  }
})

test('Qwen AI non-stream parsing maps malformed JSON and upstream transport aborts to 502', async () => {
  for (const failUpstream of [
    upstream => upstream.end('data: {not-json}\n\n'),
    upstream => upstream.destroy(new Error('aborted')),
  ]) {
    const { QwenAiStreamHandler } = loadQwenAiStreamHandler()
    const upstream = new PassThrough()
    upstream.on('error', () => {})
    const handler = new QwenAiStreamHandler('test-model')
    const result = handler.handleNonStream(upstream)

    failUpstream(upstream)

    await assert.rejects(result, error => (
      error.status === 502
      && error.retryable === false
    ))
  }
})

test('Qwen AI invalid HTTP 200 non-SSE responses never become successful HTTP statuses', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: {} },
  )

  const genericError = await adapter.createInvalidStreamError({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ success: false, message: 'upstream rejected the request' }),
  }, 'returned a non-stream response instead of a chat event stream')
  assert.equal(genericError.status, 502)
  assert.equal(genericError.retryable, false)

  const quotaError = await adapter.createInvalidStreamError({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ error: { code: 'quota_limit', details: 'service busy' } }),
  }, 'returned a non-stream response instead of a chat event stream')
  assert.equal(quotaError.status, 429)
  assert.equal(quotaError.code, 'qwen_ai_capacity_limit')
  assert.equal(quotaError.retryable, false)
})

test('Qwen AI stream ignores a transport cancellation after terminal output', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const loggedErrors = []
  const originalConsoleError = console.error
  let failureCount = 0

  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.resume()
  console.error = (...args) => {
    loggedErrors.push(args)
  }

  try {
    const ended = once(output, 'end')
    upstream.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'finished',
          content: 'ok',
          finish_reason: 'stop',
        },
      }],
    })}\n\n`)
    await ended

    const cancellation = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ERR_CANCELED',
    })
    upstream.emit('error', cancellation)
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(failureCount, 0)
    assert.equal(output.qwenAiFailure, undefined)
    assert.equal(
      loggedErrors.some(args => args[0] === '[QwenAI] Stream error:'),
      false,
    )
  } finally {
    console.error = originalConsoleError
    upstream.destroy()
  }
})

test('Qwen AI stream exposes a downstream close before upstream completion', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)

  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  output.destroy()
  const [failure] = await failurePromise

  assert.match(failure.message, /downstream stream closed before upstream completed/)
  assert.equal(failure.status, 499)
  assert.equal(failure.retryable, false)
  assert.equal(output.qwenAiFailure, failure)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream classifies an upstream truncation as a non-retryable 502', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'qwen_ai_stream_incomplete')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /ended before an upstream completion signal/)
  assert.match(Buffer.concat(chunks).toString(), /"code":"qwen_ai_stream_incomplete"/)
})

test('Qwen AI stream classifies a terminal stream without output as an empty 502', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end('data: [DONE]\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'qwen_ai_empty_stream')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /empty response stream/)
  assert.match(Buffer.concat(chunks).toString(), /"code":"qwen_ai_empty_stream"/)
})

test('Qwen AI stream reports a managed tool validation failure through its failure channel', async () => {
  const validationFailure = {
    message: 'Provider returned a malformed enforced tool call',
    type: 'tool_call_parse_error',
    param: 'tool_calls',
    code: 'malformed_tool_call',
  }
  class PendingToolStreamParser {
    push() { return [] }
    flush() { return [] }
    recoverFromContent() { return [] }
    hasPendingToolProtocol() { return true }
    hasEmittedToolCall() { return false }
  }
  const {
    QwenAiStreamHandler,
    QWEN_AI_STREAM_FAILURE_EVENT,
  } = loadQwenAiStreamHandler({
    ToolStreamParser: PendingToolStreamParser,
    getToolStreamValidationFailure: () => validationFailure,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler(
    'qwen3.8-max-preview',
    undefined,
    { shouldParseResponse: true, toolChoiceMode: 'required' },
  )
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end('data: [DONE]\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.type, validationFailure.type)
  assert.equal(failure.code, validationFailure.code)
  assert.equal(failure.retryable, false)
  assert.equal(output.qwenAiFailure, failure)

  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"type":"tool_call_parse_error"/)
  assert.match(serialized, /"param":"tool_calls"/)
  assert.match(serialized, /"code":"malformed_tool_call"/)
  assert.match(serialized, /"status":502/)
  assert.match(serialized, /"retryable":false/)
})
