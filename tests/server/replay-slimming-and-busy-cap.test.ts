import test from 'node:test'
import assert from 'node:assert/strict'
import { slimQwenAiReplayImages } from '../../src/main/proxy/replayImageSlimming.ts'
import { createQwenAiBusyFailoverStopRule } from '../../src/main/proxy/qwenBusyFailover.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('replay slimming keeps only the newest image-bearing message intact', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'task' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'old screenshot analysis' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,OLD1' } },
      ],
    },
    { role: 'assistant', content: 'ok' },
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OLD2' } }],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'latest shot' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,NEWEST' } },
      ],
    },
  ]

  const slimmed = slimQwenAiReplayImages(messages)
  assert.equal(slimmed.length, messages.length)
  // oldest two image messages got placeholders, text preserved
  assert.deepEqual((slimmed[1].content as any[])[0].text, 'old screenshot analysis')
  assert.deepEqual((slimmed[1].content as any[])[1], { type: 'text', text: '[image omitted from replayed history]' })
  assert.deepEqual(slimmed[3].content, [{ type: 'text', text: '[image omitted from replayed history]' }])
  // newest untouched
  assert.equal((slimmed[4].content as any[])[1].image_url.url, 'data:image/png;base64,NEWEST')
  // original untouched
  assert.equal((messages[1].content as any[])[1].image_url.url, 'data:image/png;base64,OLD1')
})

test('replay slimming is a no-op with only one image-bearing message', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
  ]
  const slimmed = slimQwenAiReplayImages(messages)
  assert.equal((slimmed[0].content as any)[0].image_url.url, 'x')
})

test('busy stop rule caps same-shape upstream-busy rotations', () => {
  const busy = () => ({
    success: false as const,
    status: 503,
    error: 'busy',
    errorCode: 'qwen_ai_upstream_busy',
    retryable: true,
    accountFault: false,
    retryScope: 'next-account' as const,
  })

  const rule = createQwenAiBusyFailoverStopRule(2)
  assert.ok(rule)
  // decision points: after failure 1 (history=[1]) rotate; after 2 rotate;
  // after 3 (history has 3 busy) stop — 3 accounts total, not unbounded.
  assert.equal(rule(busy(), []), false, 'first busy failure rotates')
  assert.equal(rule(busy(), [busy()]), false, 'second busy failure rotates (rotation 2)')
  assert.equal(rule(busy(), [busy(), busy()]), false, 'third failure rotates within cap? no — history length 2 <= 2 means allow')
  assert.equal(rule(busy(), [busy(), busy(), busy()]), true, 'beyond cap: stop')

  // mixed failure shapes never trigger the cap
  assert.equal(rule(busy(), [busy(), { ...busy(), errorCode: 'qwen_ai_stream_error' } as any, busy()]), false)

  // 'off' disables the rule entirely
  process.env.CHAT2API_QWEN_AI_BUSY_FAILOVER_ROTATION_MAX = 'off'
  try {
    assert.equal(createQwenAiBusyFailoverStopRule(), undefined)
  } finally {
    delete process.env.CHAT2API_QWEN_AI_BUSY_FAILOVER_ROTATION_MAX
  }
})
