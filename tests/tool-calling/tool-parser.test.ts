import test from 'node:test'
import assert from 'node:assert/strict'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { anthropicToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/anthropicToolUse.ts'
import { codexResponsesProtocol } from '../../src/main/proxy/toolCalling/protocols/codexResponses.ts'

const tools = [
  {
    name: 'default_api:read_file',
    description: 'Read a file',
    parameters: { type: 'object' },
    source: 'openai' as const,
  },
]

test('managed bracket parses valid tool call', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(result.content, '')
})

test('managed xml parses valid Chat2API tool call', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
})

test('managed xml parses canonical XML compatibility form', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses single quoted XML attributes', () => {
  const result = managedXmlProtocol.parse(
    "<tool_calls><invoke name='default_api:read_file'><parameter name='filePath'>/tmp/a</parameter></invoke></tool_calls>",
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses mixed Chat2API and canonical XML tags', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><parameter name="filePath"><![CDATA[/tmp/a]]></parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses loose tool_call XML emitted inside a tool_calls block', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|tool_calls><|tool_call_id="default_api:read_file"><parameter name="filePath"><![CDATA[/tmp/a]]></parameter></tool_call></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml flattens wrapper argument objects when schema has no wrapper property', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument">{"filePath":"/tmp/a"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { filePath: '/tmp/a' })
})

test('managed xml preserves wrapper argument when declared by schema', () => {
  const wrapperTools = [
    {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          argument: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
          },
        },
      },
      source: 'openai' as const,
    },
  ]

  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument">{"filePath":"/tmp/a"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: wrapperTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { argument: { filePath: '/tmp/a' } })
})

test('managed xml recovers partial Chat2API block only when final parsing allows it', () => {
  const partial =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>'
  const streamingResult = managedXmlProtocol.parse(partial, { tools, protocol: 'managed_xml' })
  const finalResult = managedXmlProtocol.parse(partial, { tools, protocol: 'managed_xml', allowPartial: true })

  assert.equal(streamingResult.toolCalls.length, 0)
  assert.equal(finalResult.toolCalls.length, 1)
  assert.equal(JSON.parse(finalResult.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml recovers missing invoke close when parameter is complete', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml recovers complete JSON parameter without a parameter close tag', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">"/tmp/a"</|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml does not recover partial block without complete parameter content', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml does not invent parameters from incomplete JSON values', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">"/tmp/a',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml ignores fenced tool examples', () => {
  const result = managedXmlProtocol.parse(
    '```xml\n<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">fake</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>\n```',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('unknown tool name is rejected', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:missing_tool]{"x":1}[/call][/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('managed XML parser rejects undeclared tool names and records invalid names', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing_tool">{}</|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('anthropic adapter parses antml function calls', () => {
  const result = anthropicToolUseProtocol.parse(
    '<antml:function_calls><antml:invoke name="default_api:read_file"><antml:parameters>{"filePath":"/tmp/a"}</antml:parameters></antml:invoke></antml:function_calls>',
    { tools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
})

test('codex responses adapter parses response item function call', () => {
  const result = codexResponsesProtocol.parse(
    JSON.stringify({
      type: 'function_call',
      call_id: 'call_1',
      name: 'default_api:read_file',
      arguments: '{"filePath":"/tmp/a"}',
    }),
    { tools, protocol: 'codex_responses' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].id, 'call_1')
})
