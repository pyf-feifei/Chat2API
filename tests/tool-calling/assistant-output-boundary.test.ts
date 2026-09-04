import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAssistantOutputBoundaryStream } from '../../src/main/proxy/toolCalling/assistantOutputBoundary.ts'

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(String(chunk))
  return chunks.join('')
}

function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-boundary',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

test('assistant output boundary rejects a wrapper split across reasoning deltas', async () => {
  const source = Readable.from([
    frame({ reasoning_content: 'checking <|CHAT2API|tool_' }),
    frame({ reasoning_content: 'result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>' }),
    frame({}, 'stop'),
    'data: [DONE]\n\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  await assert.rejects(
    collect(boundary),
    (error: Error & { status?: number, code?: string, param?: string }) => (
      error.status === 502
      && error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'reasoning_content'
    ),
  )
})

test('assistant output boundary leaves wrapper literals in tool arguments untouched', async () => {
  const literal = '<|CHAT2API|tool_result tool_call_id="call_fixture"><![CDATA[value]]></|CHAT2API|tool_result>'
  const source = Readable.from([
    frame({
      tool_calls: [{
        index: 0,
        id: 'call_fixture',
        type: 'function',
        function: {
          name: 'write_fixture',
          arguments: JSON.stringify({ value: literal }),
        },
      }],
    }),
    frame({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  const output = await collect(boundary)
  assert.match(output, /CHAT2API\\u007ctool_result|CHAT2API\|tool_result/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.match(output, /data: \[DONE\]/)
})

test('assistant output boundary flushes an ordinary marker-like suffix before stop', async () => {
  const source = Readable.from([
    frame({ content: 'ordinary <|CHAT2API|tool_x' }),
    frame({}, 'stop'),
    'data: [DONE]\n\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  const output = await collect(boundary)
  assert.match(output, /ordinary <\|CHAT2API\|tool_x/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.match(output, /data: \[DONE\]/)
})

test('assistant output boundary rejects a distinctive partial wrapper at EOF', async () => {
  const source = Readable.from([frame({ content: '<|CHAT2API|tool_result' })])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  await assert.rejects(
    collect(boundary),
    (error: Error & { code?: string, param?: string }) => (
      error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'content'
    ),
  )
})

test('assistant output boundary rejects generic tool-call-results wrappers', async () => {
  const source = Readable.from([
    frame({ content: 'before <tool_call_results id="call_fixture">result' }),
    frame({ content: '</tool_call_results> after' }),
    frame({}, 'stop'),
    'data: [DONE]\\n\\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  await assert.rejects(
    collect(boundary),
    (error: Error & { code?: string, param?: string }) => (
      error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'content'
    ),
  )
})

test('assistant output boundary rejects malformed tool-call-result output with legacy close tags', async () => {
  const source = Readable.from([
    frame({ content: 'Let me inspect the docs. <tool_call_result>\\n<function_results>\\n<result>hidden</result>\\n<parameter name="output">docs\\n</parameter_results>\\n' }),
    frame({ content: '**Done**' }),
    frame({}, 'stop'),
    'data: [DONE]\\n\\n',
  ])
  const boundary = createAssistantOutputBoundaryStream(null)
  source.pipe(boundary)

  await assert.rejects(
    collect(boundary),
    (error: Error & { code?: string, param?: string }) => (
      error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'content'
    ),
  )
})

test('assistant output boundary preserves a legal tool-call tag', async () => {
  const source = Readable.from([
    frame({ content: '<tool_call><function=read_fixture></function></tool_call>' }),
    frame({}, 'tool_calls'),
    'data: [DONE]\\n\\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  const output = await collect(boundary)
  assert.match(output, /<tool_call>/)
})

test('Responses non-stream boundary rejects malformed provider tool-call XML', async () => {
  const { guardAssistantOutputCompletion } = await import(
    '../../src/main/proxy/toolCalling/assistantOutputBoundary.ts'
  )
  const completion = {
    id: 'chatcmpl-malformed',
    object: 'chat.completion',
    created: 1,
    model: 'upstream',
    choices: [{
      index: 0,
      message: {
        role: 'assistant' as const,
        content: [
          '<tool_call=\n',
          '<function>exec_command>\n',
          '<parameter cmd="Get-ChildItem">\n',
          'actual command body\n',
          '</parameter>\n',
          '</function\n</tool_call=>\n',
        ].join(''),
      },
      finish_reason: 'stop' as const,
    }],
  }
  assert.throws(
    () => guardAssistantOutputCompletion(completion, null),
    (error: Error & { code?: string, param?: string, status?: number }) => (
      error.status === 502
      && error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'choices[0].message.content'
    ),
  )
})

test('Responses non-stream boundary preserves a structured call alongside literal marker text', async () => {
  const { guardAssistantOutputCompletion } = await import(
    '../../src/main/proxy/toolCalling/assistantOutputBoundary.ts'
  )
  const completion = {
    id: 'chatcmpl-mixed',
    object: 'chat.completion',
    created: 1,
    model: 'upstream',
    choices: [{
      index: 0,
      message: {
        role: 'assistant' as const,
        content: 'Here is the call:',
        tool_calls: [{
          id: 'call_x',
          type: 'function' as const,
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({ note: 'use <tool_call> literal' }),
          },
        }],
      },
      finish_reason: 'tool_calls' as const,
    }],
  }
  const guarded = guardAssistantOutputCompletion(completion, null) as typeof completion
  assert.equal(guarded.choices[0].message?.content, 'Here is the call:')
  assert.equal(guarded.choices[0].message?.tool_calls?.[0]?.function.arguments,
    JSON.stringify({ note: 'use <tool_call> literal' }))
})
