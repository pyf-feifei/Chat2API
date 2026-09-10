import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  slimQwenAiReplayImages,
  qwenAiImageSlimModeFromEnv,
  shouldSlimQwenAiAttemptImages,
} from '../../src/main/proxy/replayImageSlimming.ts'
import { createQwenAiBusyFailoverStopRule } from '../../src/main/proxy/qwenBusyFailover.ts'
import {
  createQwenAiContentFailoverStopRule,
  combineQwenAiFailoverStopRules,
  isQwenAiContentDeterminedFailure,
} from '../../src/main/proxy/qwenContentFailover.ts'
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

test('busy stop rule signals rotation stop exactly once at the cap decision', () => {
  const busy = () => ({
    success: false as const,
    status: 503,
    error: 'busy',
    errorCode: 'qwen_ai_upstream_busy',
    retryable: true,
    accountFault: false,
    retryScope: 'next-account' as const,
  })

  let stopped = 0
  const rule = createQwenAiBusyFailoverStopRule(2, { onRotationStopped: () => { stopped += 1 } })
  assert.ok(rule)
  // rotating under the cap never fires the hook
  assert.equal(rule(busy(), [busy(), busy()]), false)
  assert.equal(stopped, 0, 'within cap: no stop signal')
  // the stop decision fires it exactly once
  assert.equal(rule(busy(), [busy(), busy(), busy()]), true)
  assert.equal(stopped, 1)
  // mixed history neither stops nor fires
  assert.equal(rule(busy(), [busy(), { ...busy(), errorCode: 'qwen_ai_stream_error' } as any, busy()]), false)
  assert.equal(stopped, 1, 'mixed history: no additional stop signal')
  // 'off' creates no rule, so the hook can never fire
  process.env.CHAT2API_QWEN_AI_BUSY_FAILOVER_ROTATION_MAX = 'off'
  try {
    assert.equal(createQwenAiBusyFailoverStopRule(undefined, { onRotationStopped: () => { stopped += 1 } }), undefined)
  } finally {
    delete process.env.CHAT2API_QWEN_AI_BUSY_FAILOVER_ROTATION_MAX
  }
  assert.equal(stopped, 1)
})

test('content stop rule caps content-determined 422 rotations', () => {
  const content = (errorCode = 'qwen_ai_semantic_incomplete') => ({
    success: false as const,
    status: 422,
    error: 'content rejection',
    errorCode,
    retryable: false,
    accountFault: false,
  })

  const rule = createQwenAiContentFailoverStopRule(1)
  assert.ok(rule)
  // cap 1 = at most 2 rotations (3 accounts total), matching the busy rule's
  // comparison shape (history.length > maxRotations)
  assert.equal(rule(content(), []), false, 'first content failure rotates')
  assert.equal(rule(content(), [content()]), false, 'second failure still within rotation 1')
  // second content rotation would follow the same rejected content: stop
  assert.equal(rule(content(), [content(), content()]), true, 'beyond cap: stop')
  // the deployment default is even tighter: 0 extra rotations (2 accounts)
  const defaultRule = createQwenAiContentFailoverStopRule(0)
  assert.ok(defaultRule)
  assert.equal(defaultRule(content(), [content()]), true, 'default cap stops after the one shared replay')
  // mixed history (busy → semantic) keeps rotating; capacity ≠ content
  const busy = {
    success: false as const,
    status: 503,
    error: 'busy',
    errorCode: 'qwen_ai_upstream_busy',
    retryable: true,
    accountFault: false,
    retryScope: 'next-account' as const,
  }
  assert.equal(rule(content(), [busy, content()]), false)
  // non-content neutral codes never trigger
  assert.equal(rule({ ...content('qwen_ai_queue_timeout') }, []), false)
  // an unparsed transcript upload is decided by the payload, not the account
  // (observed: the same 84K-token transcript failed file-parse on six
  // consecutive accounts, each burning the full 120s parse budget)
  assert.equal(rule({ ...content('qwen_ai_file_parse_timeout') }, [content('qwen_ai_file_parse_timeout'), content('qwen_ai_file_parse_timeout')]), true)
  assert.equal(defaultRule({ ...content('qwen_ai_file_parse_timeout') }, [content('qwen_ai_file_parse_timeout')]), true)
  assert.equal(defaultRule({ ...content('qwen_ai_file_parse_timeout') }, []), false, 'first parse timeout still grants the one shared replay')
  // accountFault not explicitly false is not a content-determined failure
  assert.equal(rule({ ...content(), accountFault: undefined }, []), false)
  assert.equal(isQwenAiContentDeterminedFailure({ ...content(), accountFault: undefined }), false)
  assert.equal(isQwenAiContentDeterminedFailure(content('qwen_ai_wrapper_leak')), true)

  // 'off' disables; invalid values fall back to the default 0
  process.env.CHAT2API_QWEN_AI_CONTENT_FAILOVER_ROTATION_MAX = 'off'
  try {
    assert.equal(createQwenAiContentFailoverStopRule(), undefined)
    process.env.CHAT2API_QWEN_AI_CONTENT_FAILOVER_ROTATION_MAX = 'bogus'
    const fallback = createQwenAiContentFailoverStopRule()
    assert.ok(fallback)
    assert.equal(fallback(content(), [content(), content()]), true, 'invalid env falls back to cap 0')
  } finally {
    delete process.env.CHAT2API_QWEN_AI_CONTENT_FAILOVER_ROTATION_MAX
  }
})

test('combine stop rules consults every active rule', () => {
  const content = {
    success: false as const,
    status: 422,
    error: 'content rejection',
    errorCode: 'qwen_ai_semantic_incomplete',
    retryable: false,
    accountFault: false,
  }
  const busy = {
    success: false as const,
    status: 503,
    error: 'busy',
    errorCode: 'qwen_ai_upstream_busy',
    retryable: true,
    accountFault: false,
    retryScope: 'next-account' as const,
  }

  // all-disabled → undefined keeps the failover loop's original behavior
  assert.equal(combineQwenAiFailoverStopRules(undefined, undefined), undefined)
  // single rule passes through
  const contentOnly = combineQwenAiFailoverStopRules(undefined, createQwenAiContentFailoverStopRule(1))
  assert.ok(contentOnly)
  assert.equal(contentOnly(busy, [busy, busy, busy]), false, 'busy chain never trips the content rule')
  // composed: either rule's stop condition wins
  const combined = combineQwenAiFailoverStopRules(
    createQwenAiBusyFailoverStopRule(2),
    createQwenAiContentFailoverStopRule(1),
  )
  assert.ok(combined)
  assert.equal(combined(busy, [busy, busy, busy]), true, 'busy chain stops via the busy rule')
  assert.equal(combined(content, [content, content]), true, 'content chain stops via the content rule')
  assert.equal(combined(busy, [busy, content]), false, 'mixed history keeps rotating')
  assert.equal(combined(content, []), false, 'first failure always rotates')
})

test('image slim mode parses off / on-busy (default) / always from env', () => {  const saved = process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
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

test('retry nonce scope: always perturbs attempt 1, retry preserves cache path, off disables', async (t) => {
  const { applyQwenAiRetryNonce, qwenAiRetryNonceScopeFromEnv } = await import('../../src/main/proxy/adapters/qwen-ai-files.ts')
  t.after(() => {
    delete process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE
    delete process.env.CHAT2API_QWEN_AI_RETRY_NONCE
  })

  process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE = 'always'
  const first = applyQwenAiRetryNonce('body', 1)
  assert.notEqual(first, 'body', 'always scope must perturb attempt 1 (reconnect fingerprint immunity)')

  process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE = 'retry'
  assert.equal(applyQwenAiRetryNonce('body', 1), 'body', 'retry scope keeps attempt-1 upload-cache path')
  assert.notEqual(applyQwenAiRetryNonce('body', 2), 'body')

  process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE = 'off'
  assert.equal(applyQwenAiRetryNonce('body', 3), 'body')
  assert.equal(qwenAiRetryNonceScopeFromEnv(), 'off')

  delete process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE
  assert.equal(qwenAiRetryNonceScopeFromEnv(), 'retry', 'default scope unchanged')
})

test('capacity_limit (429 quota_limit) classifies as busy-family for the webshare recovery lever', async (t) => {
  const { isQwenAiUpstreamBusyResult } = await import('../../src/main/proxy/qwenBusyClassification.ts')
  t.after(() => {})
  const base = { success: false, accountFault: true, retryScope: 'next-account' }
  assert.equal(
    isQwenAiUpstreamBusyResult({ ...base, errorCode: 'qwen_ai_capacity_limit' }),
    true,
    'capacity_limit must reach the exit-IP recovery (webshare retry) despite account-fault flag',
  )
  assert.equal(
    isQwenAiUpstreamBusyResult({ ...base, errorCode: 'qwen_ai_upstream_busy', accountFault: false }),
    true,
  )
  assert.equal(isQwenAiUpstreamBusyResult({ ...base, errorCode: 'qwen_ai_upstream_busy' }), false,
    'plain busy with accountFault stays out (existing contract)')
  assert.equal(isQwenAiUpstreamBusyResult({ ...base, errorCode: 'qwen_ai_capacity_limit', success: true }), false)
})
