import assert from 'node:assert/strict'
import test from 'node:test'

import { anthropicToolResultToChatMessage } from '../../src/main/proxy/anthropic/request.ts'

function toolResult(isError?: boolean) {
  return {
    tool_use_id: 'toolu_1',
    content: 'fixture result',
    ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
  }
}

test('Anthropic conversion preserves explicit tool-result success and failure state', () => {
  for (const isError of [false, true]) {
    assert.deepEqual(anthropicToolResultToChatMessage(toolResult(isError)), {
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: 'fixture result',
      is_error: isError,
    })
  }
})

test('Anthropic conversion does not invent a tool-result status when omitted', () => {
  const converted = anthropicToolResultToChatMessage(toolResult())
  assert.equal('is_error' in converted, false)
})
