import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sessionContinuations,
  type ContinuationTurn,
} from '../../src/main/proxy/toolCalling/m365SessionContinuation.ts'

const ACCT = 'test-account'

function reset(): void {
  sessionContinuations.clear(ACCT)
}

test('extending history matches stored conversation and yields only the delta', () => {
  reset()
  const turns: ContinuationTurn[] = [
    { role: 'user', text: 'My code is ABC-999' },
    { role: 'assistant', text: 'Noted.' },
  ]
  sessionContinuations.record(ACCT, 'conv-1', 'sess-1', turns)

  const match = sessionContinuations.match(ACCT, [
    { role: 'system', content: 'be brief' },
    ...turns.map((t) => ({ role: t.role, content: t.text })),
    { role: 'user', content: 'What is my code?' },
  ])
  assert.ok(match, 'continuation should match')
  assert.equal(match.conversationId, 'conv-1')
  assert.equal(match.sessionId, 'sess-1')
  assert.equal(match.deltaText, 'What is my code?')
  assert.equal(match.matchedTurnCount, 2)
})

test('identical history (no new turn) does not match', () => {
  reset()
  const turns: ContinuationTurn[] = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ]
  sessionContinuations.record(ACCT, 'conv-1', 'sess-1', turns)
  assert.equal(sessionContinuations.match(ACCT, turns.map((t) => ({ role: t.role, content: t.text }))), undefined)
})

test('divergent history does not match (client started a different conversation)', () => {
  reset()
  sessionContinuations.record(ACCT, 'conv-1', 'sess-1', [
    { role: 'user', text: 'topic A' },
    { role: 'assistant', text: 'answer A' },
  ])
  const match = sessionContinuations.match(ACCT, [
    { role: 'user', content: 'different topic' },
  ])
  assert.equal(match, undefined)
})

test('multi-content parts and system messages are handled', () => {
  reset()
  sessionContinuations.record(ACCT, 'conv-2', 'sess-2', [
    { role: 'user', text: 'see this image and text' },
    { role: 'assistant', text: 'got it' },
  ])
  const match = sessionContinuations.match(ACCT, [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'see this image and text' },
    { role: 'assistant', content: 'got it' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'now describe it again' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ],
    },
  ])
  assert.ok(match)
  assert.equal(match.deltaText, 'now describe it again')
})

test('tool-call transcripts never participate in continuation matching', () => {
  reset()
  sessionContinuations.record(ACCT, 'conv-3', 'sess-3', [
    { role: 'user', text: 'weather?' },
    { role: 'assistant', text: 'sunny' },
  ])
  const withToolCalls = [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'w', arguments: '{}' } }] },
  ]
  assert.equal(sessionContinuations.match(ACCT, withToolCalls), undefined)
})

test('delta with multiple turns is role-labelled', () => {
  reset()
  sessionContinuations.record(ACCT, 'conv-4', 'sess-4', [
    { role: 'user', text: 'q1' },
  ])
  const match = sessionContinuations.match(ACCT, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ])
  assert.ok(match)
  assert.match(match.deltaText, /\[assistant\]\na1/)
  assert.match(match.deltaText, /\[user\]\nq2/)
})

test('per-account isolation', () => {
  reset()
  sessionContinuations.clear('other-account')
  sessionContinuations.record(ACCT, 'conv-5', 'sess-5', [
    { role: 'user', text: 'mine' },
  ])
  const other = sessionContinuations.match('other-account', [
    { role: 'user', content: 'mine' },
    { role: 'user', content: 'more' },
  ])
  assert.equal(other, undefined)
})

test('stored conversations are bounded and LRU-pruned', () => {
  reset()
  for (let i = 0; i < 6; i++) {
    sessionContinuations.record(ACCT, `conv-${i}`, `sess-${i}`, [
      { role: 'user', text: `q-${i}` },
    ])
  }
  assert.ok(sessionContinuations.size(ACCT) <= 4)
  // oldest conversations were dropped; newest still matches
  const newest = sessionContinuations.match(ACCT, [
    { role: 'user', content: 'q-5' },
    { role: 'user', content: 'again' },
  ])
  assert.ok(newest)
  assert.equal(newest.conversationId, 'conv-5')
})
