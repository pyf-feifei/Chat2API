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

test('first detection requests correction; a corrected loop escalates', async () => {
  const { responsesToolLoopCorrectionMessage, RESPONSES_TOOL_LOOP_CORRECTION_TAG } = await import('../../src/main/proxy/responses/toolLoopGuard.ts')

  const loop: ChatMessage[] = [
    { role: 'user', content: 'run the pipeline' },
    ...completedCall(1, 'update_plan', '{"plan":[]}', 'Plan updated'),
    ...completedCall(2, 'update_plan', '{"plan":[]}', 'Plan updated'),
    ...completedCall(3, 'update_plan', '{"plan":[]}', 'Plan updated'),
  ]
  const first = detectResponsesToolLoop(loop)
  assert.equal(first?.toolName, 'update_plan')
  assert.equal(first?.correctionAlreadyIssued, false)

  // The injected correction names the loop and the exact fingerprint.
  const correctionText = responsesToolLoopCorrectionMessage(first!)
  assert.match(correctionText, /update_plan/)
  assert.match(correctionText, new RegExp(RESPONSES_TOOL_LOOP_CORRECTION_TAG.replace(/[[\]]/g, '\\$&')))

  // After the correction enters history and the loop STILL repeats, the next
  // detection reports the correction as already issued.
  const persisted: ChatMessage[] = [
    ...loop,
    { role: 'user', content: correctionText },
    ...completedCall(4, 'update_plan', '{"plan":[]}', 'Plan updated'),
  ]
  const second = detectResponsesToolLoop(persisted)
  assert.equal(second?.toolName, 'update_plan')
  assert.equal(second?.correctionAlreadyIssued, true)

  // A correction for a DIFFERENT loop fingerprint must not suppress this one.
  const other = detectResponsesToolLoop([
    ...loop,
    { role: 'user', content: `${RESPONSES_TOOL_LOOP_CORRECTION_TAG} 0000000000000000]` },
  ])
  assert.equal(other?.correctionAlreadyIssued, false)
})

