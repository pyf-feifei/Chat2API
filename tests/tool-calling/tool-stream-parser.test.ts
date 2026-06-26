import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  { name: 'default_api:read_file', parameters: { type: 'object' }, source: 'openai' as const },
]

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      actualModel: 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

const baseChunk = {
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-chat',
}

test('bracket marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  assert.deepEqual(parser.push('[fun', baseChunk), [])
  const chunks = parser.push('ction_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('bracket output is text when XML protocol is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<tool_', baseChunk), [])
  const chunks = parser.push('calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('Chat2API XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|CHAT2API|tool_', baseChunk), [])
  const chunks = parser.push('calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('partial Chat2API start marker is reported as buffered so stream handlers do not leak it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<|CHAT2API|tool_calls', baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.isBuffering(), true)
})

test('text before tool call is preserved only before tool calling begins', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('before <tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls> after', baseChunk)

  assert.equal(chunks[0].choices[0].delta.content, 'before ')
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content === ' after'), false)
})

test('invalid tool name is not emitted as a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<tool_calls><invoke name="missing"><parameter name="x">1</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
})

test('duplicate equivalent XML tool calls are emitted once', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    baseChunk,
  )

  const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)
  assert.equal(toolChunks.length, 1)
  assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('duplicate equivalent XML tool calls across chunks are emitted once', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const block = '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>'

  assert.equal(parser.push(block, baseChunk).filter((chunk) => chunk.choices[0].delta.tool_calls).length, 1)
  assert.deepEqual(parser.push(block, baseChunk), [])
})

test('fenced code block examples are emitted as text and never as tool calls', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">fake</parameter></invoke></tool_calls>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('generated call IDs stay stable between emitted chunks and final state', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push('[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)
  const emittedId = chunks.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(emittedId, 'call_0')
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('incomplete internal tool block is dropped on flush instead of leaking protocol text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke', baseChunk), [])

  assert.equal(parser.hasPendingToolProtocol(), true)
  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.hasPendingToolProtocol(), true)
})

test('partial internal tool block with complete parameter is recovered on flush', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
})

test('tool block with missing invoke close is kept until flush and recovered', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|tool_calls>', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
})

test('tool block with incomplete parameter is dropped without fabricating a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">"/tmp/a', baseChunk),
    [],
  )

  assert.deepEqual(parser.flush(baseChunk), [])
})

test('accumulated answer content can recover a valid tool call at stream finish', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const content =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

  const chunks = parser.recoverFromContent(content, baseChunk, true)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
  assert.deepEqual(parser.recoverFromContent(content, baseChunk), [])
})

test('accumulated answer content does not fabricate a call from incomplete arguments', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const content =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a'

  assert.deepEqual(parser.recoverFromContent(content, baseChunk), [])
})

test('mixed XML dialect tool block emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><parameter name="filePath"><![CDATA[/tmp/a]]></parameter></invoke></tool_calls>',
    baseChunk,
  )

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
})

test('invalid internal tool block is dropped on flush instead of leaking protocol text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing"></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk),
    [],
  )

  assert.deepEqual(parser.flush(baseChunk), [])
})
