/**
 * Phase 1 Step 1: tool-pair atomicity.
 *
 * Reference: `headroom/crates/headroom-core/src/transforms/safety.rs:1-52`.
 * The upstream rationale, in its own words: compressing one half of a tool
 * call pair desynchronizes the conversation and a re-replay of the tool
 * response will mismatch the call id, producing 400s upstream.
 *
 * These tests were written before `computeToolPairs` and against
 * `isOldToolMessage`, whose rejection cases they must be a strict superset of.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeToolPairs } from '../../../src/main/proxy/services/liveZone.ts'
import type { ChatMessage } from '../../../src/main/proxy/types.ts'

function assistantWithCalls(ids: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function',
      function: { name: 'exec', arguments: '{}' },
    })),
  } as ChatMessage
}

function toolResult(id: string, text = 'ok'): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: text } as ChatMessage
}

test('OpenAI shape pairs assistant.tool_calls[].id with tool.tool_call_id', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    assistantWithCalls(['call_a']),
    toolResult('call_a'),
    { role: 'assistant', content: 'done' },
  ]
  assert.deepEqual(computeToolPairs(messages), [{ assistantIndex: 1, responseIndex: 2 }])
})

test('Anthropic shape pairs tool_use.id with tool_result.tool_use_id', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_a', name: 'exec', input: {} }],
    } as unknown as ChatMessage,
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }],
    } as unknown as ChatMessage,
  ]
  assert.deepEqual(computeToolPairs(messages), [{ assistantIndex: 1, responseIndex: 2 }])
})

test('one assistant turn with three calls resolving in one following message yields three pairs', () => {
  // The ids must match. An earlier version of this test declared
  // `call_1/2/3` and answered `toolu_1/2/3`, which is two different id
  // namespaces and correctly produced zero pairs.
  const messages: ChatMessage[] = [
    assistantWithCalls(['toolu_1', 'toolu_2', 'toolu_3']),
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'b' },
      { type: 'tool_result', tool_use_id: 'toolu_3', content: 'c' },
    ] } as unknown as ChatMessage,
  ]
  const pairs = computeToolPairs(messages)
  assert.equal(pairs.length, 3)
  for (const pair of pairs) {
    assert.equal(pair.assistantIndex, 0)
    assert.equal(pair.responseIndex, 1)
  }
})

test('mixed OpenAI tool messages and Anthropic tool_result blocks are both recognized', () => {
  const messages: ChatMessage[] = [
    assistantWithCalls(['call_openai']),
    toolResult('call_openai', 'openai result'),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_anthropic', name: 'exec', input: {} }],
    } as unknown as ChatMessage,
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_anthropic', content: 'anthropic result' }],
    } as unknown as ChatMessage,
  ]
  assert.deepEqual(computeToolPairs(messages), [
    { assistantIndex: 0, responseIndex: 1 },
    { assistantIndex: 2, responseIndex: 3 },
  ])
})

test('an orphan result has no pair', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    toolResult('call_never_declared'),
  ]
  assert.deepEqual(computeToolPairs(messages), [])
})

test('an assistant call with no following result has no pair', () => {
  const messages: ChatMessage[] = [
    assistantWithCalls(['call_unanswered']),
    { role: 'user', content: 'carry on' },
  ]
  assert.deepEqual(computeToolPairs(messages), [])
})

test('a repeated id in a later turn produces a second pair rather than consuming the first', () => {
  // Clients do replay ids across turns. Both occurrences are genuine
  // call/result pairs, so both are paired. An earlier version of this test
  // expected only the later pair, which would have left the first result
  // looking like an orphan and therefore ineligible.
  const messages: ChatMessage[] = [
    assistantWithCalls(['call_x']),
    toolResult('call_x', 'first'),
    { role: 'assistant', content: 'again' },
    assistantWithCalls(['call_x']),
    toolResult('call_x', 'second'),
  ]
  assert.deepEqual(computeToolPairs(messages), [
    { assistantIndex: 0, responseIndex: 1 },
    { assistantIndex: 3, responseIndex: 4 },
  ])
})

test('a call declared twice before either result is answered consumes results in order', () => {
  const messages: ChatMessage[] = [
    assistantWithCalls(['call_dup']),
    toolResult('call_dup', 'first answer'),
    toolResult('call_dup', 'second answer'),
  ]
  assert.deepEqual(computeToolPairs(messages), [{ assistantIndex: 0, responseIndex: 1 }],
    'the first result answers the first declaration; the second result is unpaired')
})

test('an empty or malformed message list yields no pairs and does not throw', () => {
  assert.deepEqual(computeToolPairs([]), [])
  assert.deepEqual(computeToolPairs([{ role: 'user', content: null } as ChatMessage]), [])
  assert.deepEqual(computeToolPairs([
    { role: 'assistant', content: 'text only' },
    { role: 'tool' } as ChatMessage,
    { role: 'tool', tool_call_id: '', content: 'x' } as ChatMessage,
  ]), [])
})

test('non-object content parts are ignored rather than throwing', () => {
  const messages = [
    {
      role: 'assistant',
      content: [null, 'string part', { type: 'tool_use', id: 'toolu_ok', name: 'x', input: {} }],
    },
    {
      role: 'user',
      content: [null, { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'ok' }],
    },
  ] as unknown as ChatMessage[]
  assert.deepEqual(computeToolPairs(messages), [{ assistantIndex: 0, responseIndex: 1 }])
})
