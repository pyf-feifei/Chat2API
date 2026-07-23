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
      hasToolUse: overrides.hasToolUse || (() => false),
      parseToolUse: overrides.parseToolUse || (() => []),
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
    '../toolCalling/protocols/shared': {
      normalizeArguments: overrides.normalizeArguments || ((value, tool) => {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value
        const properties = tool?.parameters?.properties || {}
        const normalized = Object.fromEntries(Object.entries(parsed || {}).map(([key, item]) => [
          key,
          properties[key]?.type === 'string' && (
            (item !== null && typeof item === 'object')
            || typeof item === 'number'
            || typeof item === 'boolean'
          )
            ? (typeof item === 'object' ? JSON.stringify(item) : String(item))
            : properties[key]?.type === 'array' && item !== null && !Array.isArray(item)
              ? [item]
              : item,
        ]))
        return JSON.stringify(normalized)
      }),
    },
    './qwen-ai-native-tools': {
      isCompleteJsonText: overrides.isCompleteJsonText || (() => true),
      mergeNativeToolArguments: overrides.mergeNativeToolArguments || ((_current, next) => next),
      normalizeNativeFunctionCallDelta: overrides.normalizeNativeFunctionCallDelta || (() => []),
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

class PassthroughToolStreamParser {
  push(content, baseChunk, includeRole) {
    return [{
      ...baseChunk,
      choices: [{
        index: 0,
        delta: {
          ...(includeRole ? { role: 'assistant' } : {}),
          content,
        },
        finish_reason: null,
      }],
    }]
  }

  flush() { return [] }
  recoverFromContent() { return [] }
  hasPendingToolProtocol() { return false }
  hasEmittedToolCall() { return false }
}

function isCompleteJsonText(value) {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
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

test('Qwen AI stream does not treat SSE heartbeats as generation progress', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})

  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 100,
    idleTimeoutMs: 20,
  })
  const ended = once(output, 'end')
  output.resume()

  const failurePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('heartbeat stream did not fail')), 300)
    output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  const heartbeat = setInterval(() => {
    upstream.write(': keep-alive\n\ndata:\n\n')
  }, 5)

  const failure = await failurePromise
  clearInterval(heartbeat)
  await ended

  assert.match(failure.message, /idle for more than/)
  assert.equal(failure.status, 504)
  upstream.destroy()
})

test('Qwen AI response timeout zero disables the absolute deadline for stream and non-stream parsing', async () => {
  const previousResponseTimeout = process.env.QWEN_AI_RESPONSE_TIMEOUT_MS
  const previousRequestTimeout = process.env.QWEN_AI_REQUEST_TIMEOUT_MS
  process.env.QWEN_AI_RESPONSE_TIMEOUT_MS = '0'
  // The old parser rejected zero and fell back to this positive request limit.
  process.env.QWEN_AI_REQUEST_TIMEOUT_MS = '20'
  let loaded
  try {
    loaded = loadQwenAiStreamHandler()
  } finally {
    if (previousResponseTimeout === undefined) delete process.env.QWEN_AI_RESPONSE_TIMEOUT_MS
    else process.env.QWEN_AI_RESPONSE_TIMEOUT_MS = previousResponseTimeout
    if (previousRequestTimeout === undefined) delete process.env.QWEN_AI_REQUEST_TIMEOUT_MS
    else process.env.QWEN_AI_REQUEST_TIMEOUT_MS = previousRequestTimeout
  }

  const {
    QwenAiStreamHandler,
    QWEN_AI_STREAM_FAILURE_EVENT,
  } = loaded
  const streamingUpstream = new PassThrough()
  streamingUpstream.on('error', () => {})
  const streamingHandler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await streamingHandler.handleStream(streamingUpstream, {
    idleTimeoutMs: 1_000,
  })
  const chunks = []
  let streamFailure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
    streamFailure = error
  })
  const ended = once(output, 'end')

  streamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'thinking_summary',
    status: 'typing',
    extra: { summary_thought: { content: ['still working'] } },
  } }] })}\n\n`)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(streamFailure, undefined)

  streamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'stream complete',
  } }] })}\n\n`)
  await ended
  assert.match(Buffer.concat(chunks).toString(), /stream complete/)

  const nonStreamingUpstream = new PassThrough()
  nonStreamingUpstream.on('error', () => {})
  const nonStreamingHandler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const resultPromise = nonStreamingHandler.handleNonStream(nonStreamingUpstream, {
    idleTimeoutMs: 1_000,
  })
  nonStreamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'thinking_summary',
    status: 'typing',
    extra: { summary_thought: { content: ['still working'] } },
  } }] })}\n\n`)
  await new Promise(resolve => setTimeout(resolve, 50))
  nonStreamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'non-stream complete',
  } }] })}\n\n`)

  const result = await resultPromise
  assert.equal(result.choices[0].message.content, 'non-stream complete')
})

test('Qwen AI stream waits for terminal output before rejecting an undeclared native tool call', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        function_call: {
          name: 'provider_internal_tool',
          arguments: '{}',
        },
      },
    }],
  })}\n\n`)

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(output.qwenAiFailure, undefined)

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'finished',
        function_call: {
          name: 'provider_internal_tool',
          arguments: '{}',
        },
      },
    }],
  })}\n\n`)

  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.type, 'upstream_tool_error')
  assert.equal(failure.param, 'tool_calls')
  assert.equal(failure.code, 'undeclared_native_tool_call')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /undeclared native tool call: provider_internal_tool/)
  assert.match(Buffer.concat(chunks).toString(), /"accountFault":false/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream does not let undeclared native tool events reset the idle timer', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 300,
    idleTimeoutMs: 25,
  })
  const ended = once(output, 'end')
  output.resume()
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const event = `data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        function_call: { name: 'provider_internal_tool', arguments: '{}' },
      },
    }],
  })}\n\n`
  const interval = setInterval(() => upstream.write(event), 5)

  const [failure] = await failurePromise
  clearInterval(interval)
  await ended

  assert.equal(failure.status, 504)
  assert.match(failure.message, /idle for more than/)
  assert.equal(failure.accountFault, undefined)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream allows usable answer text after an undeclared native tool event', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{}' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'usable answer',
    } }] })}\n\n`,
  ].join(''))

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure, undefined)
  assert.match(body, /usable answer/)
  assert.match(body, /\[DONE\]/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream allows a declared native tool after an undeclared fragment on the same call', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{}' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'declared_tool', arguments: '{"value":1}' },
    } }] })}\n\n`,
  ].join(''))

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure, undefined)
  assert.match(body, /declared_tool/)
  assert.match(body, /tool_calls/)
  assert.match(body, /\[DONE\]/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream normalizes complete native arguments against the declared schema', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write']),
    toolChoiceMode: 'auto',
    tools: [{
      name: 'Write',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
          todos: { type: 'array', items: { type: 'object' } },
        },
      },
      source: 'openai',
    }],
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    function_call: {
      name: 'Write',
      arguments: JSON.stringify({
        file_path: 'src/example.ts',
        content: { enabled: true },
        todos: { subject: 'verify', status: 'pending' },
      }),
    },
  } }] })}\n\n`)

  await ended
  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)))
  const toolCall = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || [])[0]
  assert.ok(toolCall)
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    file_path: 'src/example.ts',
    content: '{"enabled":true}',
    todos: [{ subject: 'verify', status: 'pending' }],
  })
  assert.match(Buffer.concat(chunks).toString(), /\[DONE\]/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream normalizes legacy tool_use arguments against the declared schema', async () => {
  const legacyArguments = JSON.stringify({
    taskId: 1,
    content: { enabled: true },
  })
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    hasToolUse: content => content.includes('<tool_use>'),
    parseToolUse: () => [{
      id: 'legacy-call',
      type: 'function',
      function: {
        name: 'Write',
        arguments: legacyArguments,
      },
    }],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write']),
    toolChoiceMode: 'auto',
    tools: [{
      name: 'Write',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          content: { type: 'string' },
        },
      },
      source: 'openai',
    }],
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: `<tool_use><name>Write</name><arguments>${legacyArguments}</arguments></tool_use>`,
  } }] })}\n\n`)

  await ended
  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)))
  const toolCall = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || [])[0]
  assert.ok(toolCall)
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    taskId: '1',
    content: '{"enabled":true}',
  })
})

test('Qwen AI stream applies each declared schema to parallel native tool calls', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write', 'TodoWrite']),
    toolChoiceMode: 'auto',
    tools: [
      {
        name: 'Write',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string' } },
        },
        source: 'openai',
      },
      {
        name: 'TodoWrite',
        parameters: {
          type: 'object',
          properties: { todos: { type: 'array', items: { type: 'object' } } },
        },
        source: 'openai',
      },
    ],
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'typing',
    tool_calls: [
      {
        id: 'write-call',
        function: {
          name: 'Write',
          arguments: JSON.stringify({ content: { enabled: true } }),
        },
      },
      {
        id: 'todo-call',
        function: {
          name: 'TodoWrite',
          arguments: JSON.stringify({ todos: { content: 'verify', status: 'pending' } }),
        },
      },
    ],
  } }] })}\n\n`)

  await ended
  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)))
  const toolCalls = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(toolCalls.length, 2)
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    content: '{"enabled":true}',
  })
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), {
    todos: [{ content: 'verify', status: 'pending' }],
  })
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects incomplete declared native tool arguments only at terminal output', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })
  const chunks = []
  let observedFailure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { observedFailure = error })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'think',
      status: 'typing',
      content: 'planning',
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'declared_tool', arguments: '{"value":' },
    } }] })}\n\n`,
  ].join(''))

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(observedFailure, undefined)
  assert.equal(upstream.destroyed, false)

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    function_call: { name: 'declared_tool', arguments: '{"value":' },
  } }] })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 502)
  assert.equal(failure.type, 'tool_call_parse_error')
  assert.equal(failure.param, 'tool_calls')
  assert.equal(failure.code, 'malformed_tool_call')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /incomplete JSON arguments: declared_tool/)
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /"finish_reason":"tool_calls"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects an empty declared native tool argument block', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-empty',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    function_call: { name: 'declared_tool', arguments: '' },
  } }] })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 502)
  assert.equal(failure.type, 'tool_call_parse_error')
  assert.equal(failure.code, 'malformed_tool_call')
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /incomplete JSON arguments: declared_tool/)
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /"finish_reason":"tool_calls"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects an incomplete declared call before complete calls or answer text can finish', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['complete_tool', 'incomplete_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'I will use the available tools.',
    tool_calls: [{
      id: 'native-complete',
      function: { name: 'complete_tool', arguments: '{"value":1}' },
    }, {
      id: 'native-incomplete',
      function: { name: 'incomplete_tool', arguments: '{"value":' },
    }],
  } }] })}\n\n`)

  const [failure] = await failurePromise
  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'malformed_tool_call')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /incomplete JSON arguments: incomplete_tool/)
  assert.match(body, /I will use the available tools/)
  assert.doesNotMatch(body, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(body, /"finish_reason":"stop"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing rejects an undeclared native tool only at terminal output', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        tool_calls: [{
          id: 'native-call-1',
          function: {
            name: 'another_provider_tool',
            arguments: '{}',
          },
        }],
      },
    }],
  })}\n\n`)

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'finished',
        tool_calls: [{
          id: 'native-call-1',
          function: {
            name: 'another_provider_tool',
            arguments: '{}',
          },
        }],
      },
    }],
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.type === 'upstream_tool_error'
    && error.param === 'tool_calls'
    && error.code === 'undeclared_native_tool_call'
    && error.retryable === false
    && error.accountFault === false
    && /another_provider_tool/.test(error.message)
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing allows answer text after an undeclared native tool event', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{}' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'usable answer',
    } }] })}\n\n`,
  ].join(''))

  const response = await result
  assert.equal(response.choices[0].message.content, 'usable answer')
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing rejects terminal incomplete declared native tool arguments', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'think',
      status: 'typing',
      content: 'planning',
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      function_call: { name: 'declared_tool', arguments: '{"value":' },
    } }] })}\n\n`,
  ].join(''))

  await assert.rejects(result, error => (
    error.status === 502
    && error.type === 'tool_call_parse_error'
    && error.param === 'tool_calls'
    && error.code === 'malformed_tool_call'
    && error.retryable === false
    && error.accountFault === false
    && /incomplete JSON arguments: declared_tool/.test(error.message)
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream rejects an incomplete declared call before complete calls or answer text can finish', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['complete_tool', 'incomplete_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'I will use the available tools.',
    tool_calls: [{
      id: 'native-complete',
      function: { name: 'complete_tool', arguments: '{"value":1}' },
    }, {
      id: 'native-incomplete',
      function: { name: 'incomplete_tool', arguments: '{"value":' },
    }],
  } }] })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.type === 'tool_call_parse_error'
    && error.code === 'malformed_tool_call'
    && error.retryable === false
    && error.accountFault === false
    && /incomplete JSON arguments: incomplete_tool/.test(error.message)
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing does not accept a native tool after truncated upstream output', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.end(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        tool_calls: [{
          id: 'native-call-1',
          function: {
            name: 'declared_tool',
            arguments: '{"value":',
          },
        }],
      },
    }],
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.code === 'qwen_ai_stream_incomplete'
    && error.retryable === false
  ))
  assert.equal(upstream.destroyed, true)
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

    assert.equal(upstream.destroyed, true)

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

test('Qwen AI stream destroys upstream and ignores events after terminal output', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'finished',
          content: 'done',
          finish_reason: 'stop',
        },
      }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'typing',
          content: 'late content',
        },
      }],
    })}\n\n`,
  ].join(''))

  await ended

  assert.equal(upstream.destroyed, true)
  assert.match(Buffer.concat(chunks).toString(), /done/)
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /late content/)
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
  assert.equal(failure.accountFault, false)
  assert.equal(output.qwenAiFailure, failure)

  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"type":"tool_call_parse_error"/)
  assert.match(serialized, /"param":"tool_calls"/)
  assert.match(serialized, /"code":"malformed_tool_call"/)
  assert.match(serialized, /"accountFault":false/)
  assert.match(serialized, /"status":502/)
  assert.match(serialized, /"retryable":false/)
})
