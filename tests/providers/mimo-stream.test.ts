import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { MimoStreamHandler } from '../../src/main/proxy/adapters/mimo.ts'

function sse(lines: string[]): Readable {
  return Readable.from(lines)
}

test('Mimo stream captures flat usage events and terminates with [DONE]', async () => {
  const stream = sse([
    'event: dialogId\n',
    'data: {"type":null,"content":"479117","usage":null}\n\n',
    'event: message\n',
    'data: {"type":"text","content":"pong"}\n\n',
    'event: usage\n',
    'data: {"promptTokens":2239,"completionTokens":71,"totalTokens":2310,"nativeUsage":{"prompt_tokens":2239,"completion_tokens":71,"total_tokens":2310,"completion_tokens_details":{"reasoning_tokens":14}}}\n\n',
    'event: finish\n',
    'data: {"type":null,"content":"[DONE]","usage":null}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2.6-flash', 'conv_1', 'separate')
  const chunks: string[] = []
  for await (const chunk of handler.handleStream(stream)) {
    chunks.push(chunk)
  }

  const output = chunks.join('')
  assert.match(output, /"content":"pong"/)
  assert.match(output, /"prompt_tokens":2239/)
  assert.match(output, /"completion_tokens":71/)
  assert.match(output, /"total_tokens":2310/)
  assert.match(output, /"reasoning_tokens":14/)
  assert.ok(output.trimEnd().endsWith('data: [DONE]'), 'stream must end with the OpenAI terminator')
  assert.doesNotMatch(output, /"content":"\[DONE\]"/, 'upstream finish marker must not leak as content')
})

test('Mimo stream surfaces upstream error events as retryable account-neutral failures', async () => {
  const stream = sse([
    'event: message\n',
    'data: {"type":"text","content":"partial"}\n\n',
    'event: error\n',
    'data: {"code":70016,"msg":"验证码输入错误"}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2.6-flash', 'conv_1', 'separate')

  await assert.rejects(async () => {
    for await (const _chunk of handler.handleStream(stream)) {
      void _chunk
    }
  }, (error) => {
    assert.equal((error as { errorCode?: string }).errorCode, 'mimo_upstream_error')
    assert.equal((error as { accountFault?: boolean }).accountFault, false)
    assert.equal((error as { retryable?: boolean }).retryable, true)
    assert.match((error as Error).message, /验证码输入错误/)
    return true
  })
})

test('Mimo stream reads upstream busy errors from the content field', async () => {
  const stream = sse([
    'event: error\n',
    'data: {"type":"text","content":"服务器繁忙，请稍后再试","usage":null}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2.6-flash', 'conv_1', 'separate')

  await assert.rejects(async () => {
    for await (const _chunk of handler.handleStream(stream)) {
      void _chunk
    }
  }, (error) => {
    assert.equal((error as { errorCode?: string }).errorCode, 'mimo_upstream_error')
    assert.equal((error as { accountFault?: boolean }).accountFault, false)
    assert.equal((error as { retryable?: boolean }).retryable, true)
    assert.match((error as Error).message, /服务器繁忙/)
    return true
  })
})

test('Mimo stream skips malformed SSE frames without failing the response', async () => {
  const stream = sse([
    'event: message\n',
    'data: {"type":"text","content":"a"\n\n',
    'data: not-json\n\n',
    'event: message\n',
    'data: {"type":"text","content":"b"}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2.6-flash', 'conv_1', 'separate')
  const chunks: string[] = []
  for await (const chunk of handler.handleStream(stream)) {
    chunks.push(chunk)
  }

  const output = chunks.join('')
  assert.doesNotMatch(output, /"content":"a"/, 'the malformed frame must be dropped')
  assert.match(output, /"content":"b"/, 'later well-formed frames must still stream')
  assert.match(output, /"finish_reason":"stop"/)
})

test('Mimo non-stream path reports usage from flat events', async () => {
  const stream = sse([
    'event: message\n',
    'data: {"type":"text","content":"hello"}\n\n',
    'event: usage\n',
    'data: {"promptTokens":10,"completionTokens":2,"totalTokens":12}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2.6-flash', 'conv_1', 'separate')
  const result = JSON.parse(await handler.handleNonStream(stream))
  assert.equal(result.choices[0].message.content, 'hello')
  assert.equal(result.usage.prompt_tokens, 10)
  assert.equal(result.usage.total_tokens, 12)
})
