import assert from 'node:assert/strict'
import test from 'node:test'
import { detectResponsesToolLoop } from '../../src/main/proxy/responses/toolLoopGuard.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function completedCall(
  index: number,
  name: string,
  argumentsValue: string,
  result: string,
): ChatMessage[] {
  const id = `call_${index}`
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: argumentsValue } }],
    },
    { role: 'tool', tool_call_id: id, content: result },
  ]
}

test('Responses tool loop guard detects repeated canonical calls with unchanged results', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'inspect the route' },
    ...completedCall(1, 'exec_command', '{"cmd":"rg route","max":10}', 'same output'),
    ...completedCall(2, 'exec_command', '{ "max": 10, "cmd": "rg route" }', 'same output'),
    ...completedCall(3, 'exec_command', '{"cmd":"rg route","max":10}', 'same output'),
  ]
  const detection = detectResponsesToolLoop(messages)
  assert.equal(detection?.toolName, 'exec_command')
  assert.equal(detection?.repeatCount, 3)
  assert.match(detection?.fingerprint ?? '', /^[a-f0-9]{16}$/)
})

test('Responses tool loop guard permits progress, a new user turn, and polling tools', () => {
  const changingResults: ChatMessage[] = [
    { role: 'user', content: 'inspect the route' },
    ...completedCall(1, 'exec_command', '{"cmd":"rg route"}', 'one'),
    ...completedCall(2, 'exec_command', '{"cmd":"rg route"}', 'two'),
    ...completedCall(3, 'exec_command', '{"cmd":"rg route"}', 'three'),
  ]
  assert.equal(detectResponsesToolLoop(changingResults), undefined)

  const newTurn: ChatMessage[] = [
    ...completedCall(1, 'exec_command', '{"cmd":"rg route"}', 'same'),
    ...completedCall(2, 'exec_command', '{"cmd":"rg route"}', 'same'),
    { role: 'user', content: 'continue with a different goal' },
    ...completedCall(3, 'exec_command', '{"cmd":"rg route"}', 'same'),
  ]
  assert.equal(detectResponsesToolLoop(newTurn), undefined)

  const polling: ChatMessage[] = [
    ...completedCall(1, 'wait', '{"cell_id":"1"}', 'still running'),
    ...completedCall(2, 'wait', '{"cell_id":"1"}', 'still running'),
    ...completedCall(3, 'wait', '{"cell_id":"1"}', 'still running'),
  ]
  assert.equal(
    detectResponsesToolLoop(polling, { ignoredTools: ['wait'] }),
    undefined,
  )
})

test('Responses tool loop guard does not ignore client-defined names by default', () => {
  const polling: ChatMessage[] = [
    ...completedCall(1, 'wait', '{"cell_id":"1"}', 'still running'),
    ...completedCall(2, 'wait', '{"cell_id":"1"}', 'still running'),
    ...completedCall(3, 'wait', '{"cell_id":"1"}', 'still running'),
  ]
  assert.equal(detectResponsesToolLoop(polling)?.toolName, 'wait')
})
