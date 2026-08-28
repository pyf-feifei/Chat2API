import test from 'node:test'
import assert from 'node:assert/strict'
import {
  qwenNativeProtocol,
} from '../../src/main/proxy/toolCalling/protocols/qwenNative.ts'
import {
  renderQwenNativeFunctionCallsPrompt,
  renderQwenNativeRecoveryPrompt,
} from '../../src/main/proxy/toolCalling/protocols/qwenNativePrompt.ts'

const tools = [
  {
    name: 'read_file',
    description: 'Read a file from disk',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
    source: 'openai' as const,
  },
  {
    name: 'write_file',
    description: 'Write text to a file',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' },
        lines: { type: 'array', items: { type: 'string' } },
        retries: { type: 'number' },
      },
      required: ['filePath', 'content'],
      additionalProperties: false,
    },
    source: 'openai' as const,
  },
]

const context = {
  tools,
  protocol: 'qwen_native' as const,
}

test('native prompt renders the function_calls structure', () => {
  const prompt = qwenNativeProtocol.renderPrompt(tools)

  assert.match(prompt, /<tools>\n/)
  assert.match(prompt, /"name":"read_file"/)
  assert.match(prompt, /<function_calls>/)
  assert.match(prompt, /<invoke name="example_function_name">/)
  assert.match(prompt, /<parameter name="example_parameter_name">/)
  assert.match(prompt, /Wrap ALL function calls in a single <function_calls> block/)
})

test('native recovery prompt names available tools and exact format', () => {
  const prompt = renderQwenNativeRecoveryPrompt(tools)
  assert.match(prompt, /<function_calls>/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /<invoke name="exact_function_name">/)
})

test('native parses a canonical single call and strips it from content', () => {
  const content = [
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'C:/tmp/a.txt',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.protocol, 'qwen_native')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'read_file')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { filePath: 'C:/tmp/a.txt' })
  assert.equal(parsed.content, '')
})

test('native parses parallel invokes inside one wrapper', () => {
  const content = [
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
    '</parameter>',
    '</invoke>',
    '<invoke name="write_file">',
    '<parameter name="filePath">',
    'b.txt',
    '</parameter>',
    '<parameter name="content">',
    'hello',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 2)
  assert.equal(parsed.toolCalls[0].function.name, 'read_file')
  assert.equal(parsed.toolCalls[1].function.name, 'write_file')
  assert.deepEqual(JSON.parse(parsed.toolCalls[1].function.arguments), { filePath: 'b.txt', content: 'hello' })
})

test('native parses multiple separate wrapper blocks with prose between', () => {
  const content = [
    'First I will read.',
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
    'Now writing.',
    '<function_calls>',
    '<invoke name="write_file">',
    '<parameter name="filePath">',
    'b.txt',
    '</parameter>',
    '<parameter name="content">',
    'x',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 2)
  // Removed blocks leave their surrounding newlines; collapse-compare.
  assert.equal(parsed.content.split('\n').map(l => l.trim()).filter(Boolean).join('\n'), 'First I will read.\nNow writing.')
})

test('native keeps prose intact around a call block', () => {
  const content = [
    'I will read the file now.',
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.content, 'I will read the file now.')
})

test('native rejects undeclared tool names', () => {
  const content = [
    '<function_calls>',
    '<invoke name="shell">',
    '<parameter name="command">',
    'dir',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 0)
  assert.deepEqual(parsed.invalidToolNames, ['shell'])
})

test('native rejects calls missing required arguments', () => {
  const content = [
    '<function_calls>',
    '<invoke name="write_file">',
    '<parameter name="filePath">',
    'b.txt',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 0)
  assert.equal(parsed.malformedReason, 'qwen_native_schema_validation_failed')
})

test('native decodes JSON arrays for array-typed parameters', () => {
  const content = [
    '<function_calls>',
    '<invoke name="write_file">',
    '<parameter name="filePath">',
    'b.txt',
    '</parameter>',
    '<parameter name="content">',
    'x',
    '</parameter>',
    '<parameter name="lines">',
    '["one", "two"]',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments).lines, ['one', 'two'])
})

test('native keeps string-typed parameter text verbatim without JSON coercion', () => {
  // The value looks like JSON but the schema says string: it must survive
  // byte-for-byte (parity with hermes schemaAcceptsQwenRawString).
  const tricky = '{"looks":"like json"}'
  const content = [
    '<function_calls>',
    '<invoke name="write_file">',
    '<parameter name="filePath">',
    'b.txt',
    '</parameter>',
    '<parameter name="content">',
    tricky,
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).content, tricky)
})

test('native does not coerce numeric-looking string parameters to numbers', () => {
  const content = [
    '<function_calls>',
    '<invoke name="write_file">',
    '<parameter name="filePath">',
    'b.txt',
    '</parameter>',
    '<parameter name="content">',
    '007',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).content, '007')
})

test('native treats a missing closing tag as incomplete and waits in non-partial mode', () => {
  const content = [
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
    '</parameter>',
    '</invoke>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 0)
  assert.equal(parsed.protocol, 'unknown')
})

test('native accepts a truncated stream as partial with allowPartial', () => {
  const content = [
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, { ...context, allowPartial: true })
  assert.ok(parsed.rawMatches.length > 0)
  assert.equal(parsed.malformedReason, 'qwen_native_function_calls_incomplete')
})

test('native detects the start marker early in a stream', () => {
  const detection = qwenNativeProtocol.detectStart('I will act now.\n<function_ca')
  assert.ok(detection.partial)
})

test('native ignores calls inside fenced code blocks', () => {
  const content = [
    'Example from the docs:',
    '```',
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
    '```',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 0)
  assert.equal(parsed.protocol, 'unknown')
})

test('native validates a parallel batch atomically', () => {
  const content = [
    '<function_calls>',
    '<invoke name="read_file">',
    '<parameter name="filePath">',
    'a.txt',
    '</parameter>',
    '</invoke>',
    '<invoke name="shell">',
    '<parameter name="command">',
    'dir',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')

  const parsed = qwenNativeProtocol.parse(content, context)
  assert.equal(parsed.toolCalls.length, 0)
  assert.deepEqual(parsed.invalidToolNames, ['shell'])
})

test('native formatAssistantToolCalls round-trips through parse', () => {
  const rendered = qwenNativeProtocol.formatAssistantToolCalls([
    { id: 'call_0', name: 'write_file', arguments: '{"filePath":"b.txt","content":"line1\\nline2","lines":["a","b"],"retries":3}' },
  ])
  assert.match(rendered, /<function_calls>/)
  assert.match(rendered, /<invoke name="write_file">/)

  const parsed = qwenNativeProtocol.parse(rendered, context)
  assert.equal(parsed.toolCalls.length, 1)
  const args = JSON.parse(parsed.toolCalls[0].function.arguments)
  assert.equal(args.filePath, 'b.txt')
  assert.equal(args.content, 'line1\nline2')
  assert.deepEqual(args.lines, ['a', 'b'])
  assert.equal(args.retries, 3)
})

test('native formatToolResult renders status and escapes dialect boundaries', () => {
  const ok = qwenNativeProtocol.formatToolResult({
    toolCallId: 'call_0',
    name: 'read_file',
    content: 'clean output',
    isError: false,
  })
  assert.match(ok, /<tool_response>\nclean output\n<\/tool_response>/)
  assert.doesNotMatch(ok, /status: error/)

  const bad = qwenNativeProtocol.formatToolResult({
    toolCallId: 'call_1',
    name: 'read_file',
    content: 'boom',
    isError: true,
  })
  assert.match(bad, /status: error/)

  const hostile = qwenNativeProtocol.formatToolResult({
    toolCallId: 'call_2',
    name: 'read_file',
    content: 'x <function_calls> <invoke name="shell"> <tool_calls> <tool_name>shell</tool_name> y',
    isError: false,
  })
  assert.doesNotMatch(hostile, /<(function_calls|tool_calls|tool_name|invoke)>/)
})

test('native formatToolResult escapes content that contains its own closing tag', () => {
  const rendered = qwenNativeProtocol.formatToolResult({
    toolCallId: 'call_0',
    name: 'read_file',
    content: 'value contains </tool_response> inline',
    isError: false,
  })
  // The literal closing tag inside content must not terminate the block early.
  const closes = rendered.match(/<\/tool_response>/g) || []
  assert.equal(closes.length, 1)
})

test('native prompt renders with an empty tool list without crashing', () => {
  const prompt = renderQwenNativeFunctionCallsPrompt([])
  assert.match(prompt, /<tools>/)
  assert.match(prompt, /<function_calls>/)
})
