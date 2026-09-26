/**
 * Image slimming rollout — Phase 6.
 *
 * The default stays `off`, and this file is what keeps that decision honest. A
 * provider that cannot consume images must produce a byte-identical request
 * whether the mode is `off` or `always`, and a vision provider must produce a
 * measurably smaller one.
 *
 * The corpus measurement is deliberately re-stated here as a simulated
 * acceptance run rather than a live one: the raw capture is a local fixture, so
 * the honest claim is "the policy reduces the measured payload by X%", not "the
 * production share dropped". The real task-quality gate needs traffic this
 * repository does not have, and it is recorded as outstanding rather than
 * guessed at.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  resolveImageSlimPolicy,
  imageSlimModeFromEnv,
  VISION_PROVIDER_DEFAULTS,
} from '../../src/main/proxy/imageSlimPolicy.ts'
import { slimQwenAiReplayImages } from '../../src/main/proxy/replayImageSlimming.ts'
import { measureRawCapture } from '../../scripts/compress/extract-corpus.mjs'
import type { ChatMessage, Provider } from '../../src/main/proxy/types.ts'
import type { Provider as SharedProvider } from '../../src/shared/types.ts'

const SAVED_ENV = { ...process.env }
const SLIM_ENV = /SLIM|KEEP_FIRST|KEEP_LAST|PLACEHOLDER/

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  for (const key of Object.keys(process.env)) if (SLIM_ENV.test(key)) delete process.env[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const key of Object.keys(process.env)) if (SLIM_ENV.test(key)) delete process.env[key]
    Object.assign(process.env, SAVED_ENV)
  }
}

function provider(id: string): SharedProvider {
  return { id, name: id, modelCapabilities: {} } as unknown as SharedProvider
}

function policyFor(id: string, env: Record<string, string | undefined>): ReturnType<typeof resolveImageSlimPolicy> {
  let out: ReturnType<typeof resolveImageSlimPolicy>
  withEnv(env, () => {
    const p = provider(id)
    out = resolveImageSlimPolicy({
      provider: p,
      actualModel: 'm',
      mode: imageSlimModeFromEnv(p),
      afterBusyRejection: false,
    })
  })
  return out!
}

// ---------------------------------------------------------------------------
// Task 6.1 — the default-off guarantee
// ---------------------------------------------------------------------------

test('TASK 6.1: a non-vision provider is byte-identical under always and under off', () => {
  const nonVision = Object.entries(VISION_PROVIDER_DEFAULTS)
    .filter(([, enabled]) => !enabled)
    .map(([id]) => id)

  assert.ok(nonVision.length >= 5, `expected several non-vision providers, got ${nonVision.length}`)

  for (const id of nonVision) {
    const underAlways = policyFor(id, { CHAT2API_REPLAY_SLIM_IMAGES: 'always' })
    const underOff = policyFor(id, { CHAT2API_REPLAY_SLIM_IMAGES: 'off' })
    assert.equal(underAlways, undefined, `${id} must not be slimmed at mode always`)
    assert.equal(underOff, undefined, `${id} must not be slimmed at mode off`)
  }
})

test('TASK 6.1: an unknown or custom provider is never slimmed', () => {
  for (const id of ['my-custom', 'openrouter', '']) {
    assert.equal(
      policyFor(id, { CHAT2API_REPLAY_SLIM_IMAGES: 'always' }),
      undefined,
      `${id || '(empty id)'} must not be slimmed`,
    )
  }
})

test('TASK 6.1: the default really is off with a clean environment', () => {
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: undefined }, () => {
    const glm = provider('glm')
    assert.equal(imageSlimModeFromEnv(glm), 'off')
    assert.equal(resolveImageSlimPolicy({
      provider: glm, actualModel: 'glm-4', mode: 'off', afterBusyRejection: false,
    }), undefined)
  })
})

test('TASK 6.1: the mode does not inherit the Qwen value', () => {
  withEnv({
    CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_SLIM_IMAGES: undefined,
  }, () => {
    const glm = provider('glm')
    assert.equal(imageSlimModeFromEnv(glm), 'off',
      'a Qwen deployment at always must not enable proactive slimming elsewhere')
    assert.equal(imageSlimModeFromEnv(provider('qwen-ai')), 'always')
  })
})

// ---------------------------------------------------------------------------
// Task 6.2 — measurement
// ---------------------------------------------------------------------------

test('TASK 6.2: a vision provider is measurably slimmed at mode always', () => {
  const policy = policyFor('glm', {
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '0',
    CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '1',
  })
  assert.ok(policy, 'glm should be slimmed at mode always')

  const messages: ChatMessage[] = [0, 1, 2, 3].map((i) => ({
    role: 'user',
    content: [{
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${'A'.repeat(200_000)}` },
    }],
    name: `shot-${i}`,
  })) as ChatMessage[]

  const result = slimQwenAiReplayImages(messages, policy)
  assert.equal(result.messagesSlimmed, 3)
  assert.equal(result.partsSlimmed, 3)
  assert.ok(result.charsSlimmed >= 600_000,
    `expected ~600k chars dropped, got ${result.charsSlimmed}`)

  // The newest survives, which is what makes the loss acceptable.
  const last = result.messages[3].content as any[]
  assert.equal(last[0].type, 'image_url')
})

test('TASK 6.2: keepFirst retains the earliest attachments as reference anchors', () => {
  const policy = policyFor('glm', {
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '2',
    CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '1',
  })!
  const messages: ChatMessage[] = [0, 1, 2, 3, 4].map((i) => ({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1000)}` } }],
    name: `shot-${i}`,
  })) as ChatMessage[]

  const result = slimQwenAiReplayImages(messages, policy)
  const survivors = result.messages
    .map((m, i) => ((m.content as any[])[0]?.type === 'image_url' ? i : -1))
    .filter((i) => i >= 0)
  assert.deepEqual(survivors, [0, 1, 4], 'first 2 plus the newest')
})

test('TASK 6.2: the raw capture measurement is reproducible and still shows the headroom', () => {
  const raw = measureRawCapture()
  assert.ok(raw, 'the raw capture fixture is missing')
  assert.equal(raw.toolOutputs, 181)
  assert.equal(raw.imageOutputs, 17)
  assert.ok(raw.imageShare > 0.8,
    'the measured headroom should still be large; if this drops, re-read the design doc')
})

test('TASK 6.2: the rollout default is still off in the compose file', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8')
  assert.match(
    compose,
    /CHAT2API_REPLAY_SLIM_IMAGES:-\s*off\}/,
    'Phase 6 must not flip the default; promoting it is a separate decision',
  )
})

test('TASK 6.2: the acceptance results file records what is still outstanding', () => {
  const results = fs.readFileSync(
    'docs/superpowers/plans/2026-09-26-image-slimming-acceptance.md',
    'utf8',
  )
  // The task-quality gates need traffic this repository does not have. They must
  // be written down as open rather than quietly claimed as passed.
  for (const gate of ['success rate', 'tool-call schema', 'p95']) {
    assert.match(results, new RegExp(gate, 'i'), `the results file should mention the ${gate} gate`)
  }
  assert.match(results, /not measured|outstanding|pending/i,
    'the results file must be explicit about what was not measured')
})
