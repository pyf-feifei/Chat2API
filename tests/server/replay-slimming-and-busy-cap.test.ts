import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  slimQwenAiReplayImages,
  qwenAiImageSlimModeFromEnv,
  shouldSlimQwenAiAttemptImages,
} from '../../src/main/proxy/replayImageSlimming.ts'
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
  assert.match((slimmed[1].content as any[])[1].text, /^\[image omitted from replayed history/)
  assert.match((slimmed[3].content as any[])[0].text, /^\[image omitted from replayed history/)
  // newest untouched
  assert.equal((slimmed[4].content as any[])[1].image_url.url, 'data:image/png;base64,NEWEST')
  // original untouched
  assert.equal((messages[1].content as any[])[1].image_url.url, 'data:image/png;base64,OLD1')
})

test('replay slimming keeps the first N image-bearing messages as reference anchors', () => {
  const img = (tag: string): ChatMessage => ({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${tag}` } }],
  })
  // Shape of a visual-iteration session: the earliest attachments are the
  // ground-truth prototype views, the newest ones are working renders.
  const messages: ChatMessage[] = [
    { role: 'user', content: 'reproduce this car' },
    img('PROTOTYPE_SIDE'),
    img('PROTOTYPE_FRONT'),
    img('RENDER_V1'),
    img('RENDER_V2'),
    img('RENDER_V3'),
    img('RENDER_V4'),
  ]

  const slimmed = slimQwenAiReplayImages(messages, { keepFirstImageMessages: 2, keepLastImageMessages: 2 })
  const url = (index: number) => (slimmed[index].content as any[])[0].image_url?.url || ''
  const text = (index: number) => (slimmed[index].content as any[])[0].text || ''

  // reference anchors survive
  assert.ok(url(1).endsWith('PROTOTYPE_SIDE'))
  assert.ok(url(2).endsWith('PROTOTYPE_FRONT'))
  // current working set survives
  assert.ok(url(5).endsWith('RENDER_V3'))
  assert.ok(url(6).endsWith('RENDER_V4'))
  // middle iterations are placeholders
  assert.match(text(3), /^\[image omitted from replayed history/)
  assert.match(text(4), /^\[image omitted from replayed history/)
  // original untouched
  assert.ok(((messages[3].content as any[])[0].image_url.url).endsWith('RENDER_V1'))
})

test('replay slimming placeholder tells the model how to recover the image', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } }] },
  ]
  const slimmed = slimQwenAiReplayImages(messages)
  assert.match((slimmed[0].content as any[])[0].text, /view it again with your image tool/)
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

test('image slim mode parses off / on-busy (default) / always from env', () => {
  const saved = process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
  try {
    delete process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
    assert.equal(qwenAiImageSlimModeFromEnv(), 'on-busy')
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'always'
    assert.equal(qwenAiImageSlimModeFromEnv(), 'always')
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'off'
    assert.equal(qwenAiImageSlimModeFromEnv(), 'off')
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = ' ALWAYS '
    assert.equal(qwenAiImageSlimModeFromEnv(), 'always', 'case/whitespace tolerant')
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'bogus'
    assert.equal(qwenAiImageSlimModeFromEnv(), 'on-busy', 'unknown values fall back to the reactive default')
  } finally {
    if (saved === undefined) delete process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
    else process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = saved
  }
})

test('first-attempt slimming decision follows the mode, not the busy flag alone', () => {
  // 'always' slims the very first attempt — before any upstream rejection —
  // so a long visual session never batch-triggers the per-minute STS quota.
  assert.equal(shouldSlimQwenAiAttemptImages('always', false), true)
  assert.equal(shouldSlimQwenAiAttemptImages('always', true), true)
  // Default stays reactive: untouched first attempt, slimmed rotation replay.
  assert.equal(shouldSlimQwenAiAttemptImages('on-busy', false), false)
  assert.equal(shouldSlimQwenAiAttemptImages('on-busy', true), true)
  // 'off' never slims, even after a busy rejection.
  assert.equal(shouldSlimQwenAiAttemptImages('off', false), false)
  assert.equal(shouldSlimQwenAiAttemptImages('off', true), false)
})

test('slimming stays functional under always mode and disabled under off', () => {
  const saved = process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } }] },
  ]
  try {
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'always'
    const slimmed = slimQwenAiReplayImages(messages)
    assert.match((slimmed[0].content as any[])[0].text, /^\[image omitted from replayed history/)
    assert.equal((slimmed[1].content as any[])[0].image_url.url, 'data:image/png;base64,NEW')

    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'off'
    const untouched = slimQwenAiReplayImages(messages)
    assert.equal((untouched[0].content as any[])[0].image_url.url, 'data:image/png;base64,OLD')
  } finally {
    if (saved === undefined) delete process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
    else process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = saved
  }
})

test('both failover routes consult the slim mode on every attempt', () => {
  const chatRoute = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const responsesRoute = fs.readFileSync('src/main/proxy/routes/responses.ts', 'utf8')
  for (const [name, source] of [['chat', chatRoute], ['responses', responsesRoute]] as const) {
    assert.match(source, /qwenAiImageSlimModeFromEnv/, `${name} route reads the slim mode`)
    assert.match(source, /shouldSlimQwenAiAttemptImages\(imageSlimMode, slimImagesOnNextAttempt\)/, `${name} route slims per attempt`)
  }
})

test('docker-compose passes the image slimming knobs through', () => {
  const source = fs.readFileSync('docker-compose.yml', 'utf8')
  assert.match(source, /CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES/)
  assert.match(source, /CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES/)
})
