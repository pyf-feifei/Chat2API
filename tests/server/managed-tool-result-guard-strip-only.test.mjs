import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ManagedToolResultGuard,
  stripManagedToolResultWrappers,
} from '../../src/main/proxy/toolCalling/managedToolResultGuard.ts'
import {
  createAssistantOutputBoundaryStream,
  guardAssistantOutputCompletion,
} from '../../src/main/proxy/toolCalling/assistantOutputBoundary.ts'

const WRAPPER = 'summary\n<|CHAT2API|tool_result tool_call_id="call_x"><![CDATA[old]]></|CHAT2API|tool_result>\nafter'

test('stripOnly suppresses a tool-result wrapper without recording a leak', () => {
  const guard = new ManagedToolResultGuard(null, { stripOnly: true })
  const streamed = guard.push(WRAPPER)
  const flushed = guard.flush()
  const output = streamed.content + flushed.content

  assert.equal(guard.hasDetectedWrapperLeak(), false)
  assert.ok(streamed.suppressed || flushed.suppressed)
  assert.equal(output.includes('CHAT2API|tool_result'), false)
  assert.ok(output.startsWith('summary'))
  assert.ok(output.includes('after'))
})

test('default null protocol still records the same wrapper as a leak', () => {
  const guard = new ManagedToolResultGuard(null)
  guard.push(WRAPPER)
  guard.flush()
  assert.equal(guard.hasDetectedWrapperLeak(), true)
})

test('stripOnly is split-stable for the leak verdict and keeps prefix text', () => {
  const whole = new ManagedToolResultGuard(null, { stripOnly: true })
  whole.push(WRAPPER)
  whole.flush()
  assert.equal(whole.hasDetectedWrapperLeak(), false)

  for (let splitAt = 1; splitAt <= WRAPPER.length; splitAt += 1) {
    const guard = new ManagedToolResultGuard(null, { stripOnly: true })
    let output = ''
    for (let i = 0; i < WRAPPER.length; i += splitAt) {
      output += guard.push(WRAPPER.slice(i, i + splitAt)).content
    }
    output += guard.flush().content
    assert.equal(guard.hasDetectedWrapperLeak(), false, `splitAt=${splitAt}`)
    assert.equal(output.includes('CHAT2API|tool_result'), false, `splitAt=${splitAt} content`)
    assert.ok(output.startsWith('summary'), `splitAt=${splitAt} prefix`)
    assert.ok(output.includes('after'), `splitAt=${splitAt} suffix`)
  }
})

test('stripOnly strips unprotected tool-call markup without a leak verdict', () => {
  const guard = new ManagedToolResultGuard(null, { stripOnly: true })
  const streamed = guard.push('before </tool_call> after')
  const flushed = guard.flush()
  const output = streamed.content + flushed.content

  assert.equal(guard.hasDetectedWrapperLeak(), false)
  assert.equal(output.includes('</tool_call>'), false)
  assert.ok(output.includes('before'))
  assert.ok(output.includes('after'))
})

test('stripManagedToolResultWrappers forwards stripOnly', () => {
  const result = stripManagedToolResultWrappers(WRAPPER, null, { stripOnly: true })
  assert.equal(result.wrapperLeakDetected, false)
  assert.equal(result.content.includes('CHAT2API|tool_result'), false)
  assert.ok(result.content.startsWith('summary'))

  const strict = stripManagedToolResultWrappers(WRAPPER, null)
  assert.equal(strict.wrapperLeakDetected, true)
})

test('guardAssistantOutputCompletion stripOnly strips without throwing', () => {
  const body = {
    id: 'c',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: WRAPPER },
      finish_reason: 'stop',
    }],
  }
  const guarded = guardAssistantOutputCompletion(body, null, { stripOnly: true })
  const content = guarded.choices[0].message.content
  assert.equal(content.includes('CHAT2API|tool_result'), false)
  assert.ok(content.startsWith('summary'))
  assert.ok(content.includes('after'))

  assert.throws(() => guardAssistantOutputCompletion(body, null))
})

test('createAssistantOutputBoundaryStream stripOnly passes a reasoning wrapper through stripped', async () => {
  const boundary = createAssistantOutputBoundaryStream(null, { stripOnly: true })
  const chunks = []
  boundary.on('data', chunk => chunks.push(chunk))
  const ended = new Promise((resolve, reject) => {
    boundary.once('end', resolve)
    boundary.once('error', reject)
  })

  const delta = value => `data: ${JSON.stringify({
    id: 'chatcmpl-strip',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { reasoning_content: value }, finish_reason: null }],
  })}\n\n`

  boundary.write(delta('checking <|CHAT2API|tool_'))
  boundary.write(delta('result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'))
  boundary.end('data: [DONE]\n\n')
  await ended

  const body = Buffer.concat(chunks).toString()
  assert.doesNotMatch(body, /managed_tool_result_wrapper_leak|event: error/)
  assert.doesNotMatch(body, /CHAT2API\|tool_result/)
  assert.match(body, /checking/)
  assert.match(body, /data: \[DONE\]/)
})

test('createAssistantOutputBoundaryStream default still fails on the same wrapper', async () => {
  const boundary = createAssistantOutputBoundaryStream(null)
  const chunks = []
  boundary.on('data', chunk => chunks.push(chunk))
  const failed = new Promise(resolve => boundary.once('error', resolve))

  const delta = value => `data: ${JSON.stringify({
    id: 'chatcmpl-strict',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { content: value }, finish_reason: null }],
  })}\n\n`

  boundary.write(delta(WRAPPER))
  boundary.end('data: [DONE]\n\n')
  const error = await failed
  assert.equal(error.code, 'managed_tool_result_wrapper_leak')
})
