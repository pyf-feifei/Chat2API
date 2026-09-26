/**
 * Phase 0 guardrail: characterize the CURRENT Qwen image-slimming behavior.
 *
 * This file is a tripwire. Every assertion here describes how
 * `replayImageSlimming.ts` behaves today, and it must keep passing unchanged
 * after the provider-neutral work lands. If one of these fails, the refactor
 * changed Qwen's behavior, which is the one thing Critical Constraint 1
 * forbids.
 *
 * It deliberately tests the existing exported functions rather than the future
 * `resolveImageSlimPolicy`. The compatibility assertion against that resolver
 * belongs to Phase 2, once the resolver exists.
 *
 * Design: `docs/superpowers/specs/2026-09-26-provider-neutral-image-slimming-design.md`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  slimQwenAiReplayImages,
  qwenAiImageSlimModeFromEnv,
  shouldSlimQwenAiAttemptImages,
} from '../../src/main/proxy/replayImageSlimming.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const SAVED_ENV = { ...process.env }

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key]
  }
  Object.assign(process.env, SAVED_ENV)
}

function imageMessage(url: string, text: string): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url } },
    ],
  }
}

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

// ---------------------------------------------------------------------------
// Mode parsing
// ---------------------------------------------------------------------------

test('Qwen slim mode defaults to on-busy when unset', () => {
  delete process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES
  assert.equal(qwenAiImageSlimModeFromEnv(), 'on-busy')
})

test('Qwen slim mode parses off / on-busy / always', () => {
  try {
    for (const [value, expected] of [
      ['off', 'off'],
      ['on-busy', 'on-busy'],
      ['always', 'always'],
      ['ALWAYS', 'always'],
      ['  always  ', 'always'],
    ]) {
      process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = value
      assert.equal(qwenAiImageSlimModeFromEnv(), expected, `value=${value}`)
    }
  } finally {
    restoreEnv()
  }
})

test('Qwen slim mode falls back to the reactive default for unknown values', () => {
  try {
    for (const value of ['yes', 'true', '1', 'sometimes', '']) {
      process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = value
      assert.equal(qwenAiImageSlimModeFromEnv(), 'on-busy', `value=${value}`)
    }
  } finally {
    restoreEnv()
  }
})

// ---------------------------------------------------------------------------
// Trigger decision — the exact matrix the Qwen path depends on
// ---------------------------------------------------------------------------

test('Qwen trigger matrix is frozen', () => {
  const matrix = [
    // mode,        afterBusy, expected
    ['off', false, false],
    ['off', true, false],
    ['on-busy', false, false],
    ['on-busy', true, true],
    ['always', false, true],
    ['always', true, true],
  ]
  for (const [mode, afterBusy, expected] of matrix) {
    assert.equal(
      shouldSlimQwenAiAttemptImages(mode, afterBusy),
      expected,
      `mode=${mode} afterBusy=${afterBusy}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Transform behavior
// ---------------------------------------------------------------------------

test('Qwen transform keeps the newest image-bearing message and drops older ones', () => {
  try {
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'always'
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      imageMessage(DATA_URL, 'prototype'),
      { role: 'assistant', content: 'noted' },
      imageMessage('data:image/png;base64,AAAA', 'render-1'),
      { role: 'assistant', content: 'noted' },
      imageMessage('data:image/png;base64,BBBB', 'render-2'),
    ]
    const slimmed = slimQwenAiReplayImages(messages).messages

    assert.equal(slimmed[1].content.some((p: any) => p.type === 'image_url'), false,
      'older image-bearing message should be slimmed')
    assert.equal(slimmed[5].content.some((p: any) => p.type === 'image_url'), true,
      'newest image-bearing message must survive')
  } finally {
    restoreEnv()
  }
})

test('Qwen transform is a no-op when the keep set already covers every image', () => {
  // CONTRACT CHANGE, Phase 4. The transform no longer reads
  // CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES; it is a pure function of the options it
  // is given, and the mode decision belongs to `resolveImageSlimPolicy`. This
  // guardrail originally set the env to `off` and called the transform with no
  // options. That contract is gone by design; the equivalent end-to-end
  // guarantee is pinned in `replay-slimming-and-busy-cap.test.ts` as "Qwen
  // end-to-end behavior is unchanged by moving env reading into the policy".
  const messages: ChatMessage[] = [
    imageMessage(DATA_URL, 'a'),
    imageMessage('data:image/png;base64,AAAA', 'b'),
  ]
  assert.deepEqual(slimQwenAiReplayImages(messages, {
    keepFirstImageMessages: 1,
    keepLastImageMessages: 1,
  }).messages, messages)
})

test('Qwen transform never mutates the input array or its messages', () => {
  try {
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'always'
    const messages: ChatMessage[] = [
      imageMessage(DATA_URL, 'a'),
      imageMessage('data:image/png;base64,AAAA', 'b'),
      imageMessage('data:image/png;base64,BBBB', 'c'),
    ]
    const before = JSON.stringify(messages)
    const slimmed = slimQwenAiReplayImages(messages).messages
    assert.equal(JSON.stringify(messages), before, 'input array was mutated')
    assert.notEqual(slimmed[0], messages[0], 'slimmed message should be a new object')
  } finally {
    restoreEnv()
  }
})

test('Qwen transform preserves tool_call_id and ordering on slimmed messages', () => {
  try {
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'always'
    const messages: ChatMessage[] = [
      { role: 'user', content: 'task' },
      { role: 'tool', tool_call_id: 'call_old', content: [imageMessage(DATA_URL, '').content[1]] as any },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_new', content: [imageMessage('data:image/png;base64,BBBB', '').content[1]] as any },
    ]
    const slimmed = slimQwenAiReplayImages(messages).messages
    assert.equal((slimmed[1] as any).tool_call_id, 'call_old')
    assert.equal((slimmed[3] as any).tool_call_id, 'call_new')
    assert.equal(slimmed.length, messages.length)
  } finally {
    restoreEnv()
  }
})

// ---------------------------------------------------------------------------
// Keep counts
// ---------------------------------------------------------------------------

test('Qwen keep counts default to first=0 last=1', () => {
  delete process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES
  delete process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES
  const messages: ChatMessage[] = [
    imageMessage(DATA_URL, 'a'),
    imageMessage('data:image/png;base64,AAAA', 'b'),
    imageMessage('data:image/png;base64,BBBB', 'c'),
  ]
  const slimmed = slimQwenAiReplayImages(messages).messages
  const surviving = slimmed.filter((m) => (m.content as any[]).some((p) => p.type === 'image_url'))
  assert.equal(surviving.length, 1, 'only the newest should survive by default')
})

test('Qwen keep counts are honored when set', () => {
  try {
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'always'
    process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES = '2'
    process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES = '2'
    const messages: ChatMessage[] = [
      imageMessage(DATA_URL, 'a'),
      imageMessage('data:image/png;base64,AAAA', 'b'),
      imageMessage('data:image/png;base64,BBBB', 'c'),
      imageMessage('data:image/png;base64,CCCC', 'd'),
      imageMessage('data:image/png;base64,DDDD', 'e'),
    ]
    const slimmed = slimQwenAiReplayImages(messages).messages
    const surviving = slimmed.filter((m) => (m.content as any[]).some((p) => p.type === 'image_url'))
    assert.equal(surviving.length, 4, 'first 2 + last 2 should survive')
  } finally {
    restoreEnv()
  }
})

// ---------------------------------------------------------------------------
// Isolation: the future provider-neutral variables must not reach this path yet
// ---------------------------------------------------------------------------

test('the transform ignores the environment entirely', () => {
  // Phase 4 moved all env reading into the policy layer. If the transform still
  // consulted process.env, a caller that passes explicit keep counts would be
  // silently overridden, which is the failure this pins.
  try {
    process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES = 'off'
    process.env.CHAT2API_REPLAY_SLIM_IMAGES = 'off'
    const messages: ChatMessage[] = [
      imageMessage(DATA_URL, 'a'),
      imageMessage('data:image/png;base64,AAAA', 'b'),
      imageMessage('data:image/png;base64,BBBB', 'c'),
    ]
    assert.notDeepEqual(
      slimQwenAiReplayImages(messages, {
        keepFirstImageMessages: 0,
        keepLastImageMessages: 1,
      }).messages,
      messages,
      'explicit keep counts must win over the environment',
    )
  } finally {
    restoreEnv()
  }
})
