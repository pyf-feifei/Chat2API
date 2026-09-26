/**
 * Image slimming measurement — Phase 5 Task 5.1.
 *
 * `charsSlimmed` is the number that matters. It converts into the same units the
 * routes already record via `estimateQwenAiRequestInputTokens`, so the image
 * track and the text track can be added without double counting. That is the
 * whole point of measuring it here rather than logging a boolean.
 *
 * The counts must also stay non-identifying. Tool output and image payloads
 * routinely contain file contents; a count is safe, a filename or a URL
 * fragment is not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { slimQwenAiReplayImages } from '../../src/main/proxy/replayImageSlimming.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function imageMessage(label: string, payloadChars = 200_000): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: label },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(payloadChars)}` } },
    ],
  } as ChatMessage
}

const ROUTES = ['src/main/proxy/routes/chat.ts', 'src/main/proxy/routes/responses.ts']

test('a slimmed message reports how much it dropped', () => {
  const messages = [
    imageMessage('prototype'),
    imageMessage('render-1'),
    imageMessage('render-2'),
  ]
  const result = slimQwenAiReplayImages(messages, {
    keepFirstImageMessages: 0,
    keepLastImageMessages: 1,
    placeholder: '[image omitted from replayed history; if you need it, view it again with your image tool]',
  })

  assert.equal(result.messagesSlimmed, 2)
  assert.equal(result.partsSlimmed, 2)
  assert.ok(result.charsSlimmed > 400_000,
    `expected the two dropped base64 payloads to be counted, got ${result.charsSlimmed}`)
})

test('nothing slimmed reports zeros, not undefined', () => {
  const messages = [imageMessage('only')]
  const result = slimQwenAiReplayImages(messages, {
    keepFirstImageMessages: 1,
    keepLastImageMessages: 1,
  })
  assert.deepEqual(
    { m: result.messagesSlimmed, p: result.partsSlimmed, c: result.charsSlimmed },
    { m: 0, p: 0, c: 0 },
  )
})

test('charsSlimmed tracks the payload size, so the saving is measurable', () => {
  const small = slimQwenAiReplayImages(
    [imageMessage('a', 10_000), imageMessage('b', 10_000), imageMessage('c', 10_000)],
    { keepFirstImageMessages: 0, keepLastImageMessages: 1 },
  )
  const large = slimQwenAiReplayImages(
    [imageMessage('a', 200_000), imageMessage('b', 200_000), imageMessage('c', 200_000)],
    { keepFirstImageMessages: 0, keepLastImageMessages: 1 },
  )
  assert.ok(large.charsSlimmed > small.charsSlimmed * 10,
    'a 20x larger payload must report a proportionally larger saving')
})

test('only the dropped payload is counted, not the whole message', () => {
  // The text part of a slimmed message survives as the placeholder, so counting
  // the whole message would overstate the saving.
  const result = slimQwenAiReplayImages(
    [imageMessage('a'), imageMessage('b'), imageMessage('c')],
    { keepFirstImageMessages: 0, keepLastImageMessages: 1 },
  )
  const payloadChars = 200_000
  assert.ok(result.charsSlimmed < payloadChars * 3,
    'the surviving newest payload must not be counted')
})

test('the result carries counts only, never content', () => {
  const result = slimQwenAiReplayImages(
    [imageMessage('a'), imageMessage('b'), imageMessage('c')],
    { keepFirstImageMessages: 0, keepLastImageMessages: 1, placeholder: '[gone]' },
  )
  const { messages, ...counts } = result
  assert.deepEqual(
    Object.keys(counts).sort(),
    ['charsSlimmed', 'messagesSlimmed', 'partsSlimmed'],
    'the counters must be exactly these three keys',
  )
  for (const value of Object.values(counts)) {
    assert.equal(typeof value, 'number')
  }
})

test('a request with no images is untouched and reports zeros', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'just text' },
    { role: 'assistant', content: 'ok' },
  ] as ChatMessage[]
  const result = slimQwenAiReplayImages(messages, { keepFirstImageMessages: 0, keepLastImageMessages: 0 })
  assert.deepEqual(result.messages, messages)
  assert.equal(result.charsSlimmed, 0)
})

for (const route of ROUTES) {
  test(`${route} logs the image slim counters`, () => {
    const source = fs.readFileSync(route, 'utf8')
    for (const field of [
      'imageSlimApplied',
      'imageSlimReason',
      'imageSlimKeepFirst',
      'imageSlimKeepLast',
      'imageMessagesSlimmed',
      'imagePartsSlimmed',
      'imageCharsSlimmed',
    ]) {
      assert.match(source, new RegExp(field), `${route} should log ${field}`)
    }
  })

  test(`${route} logs no image identity in the slimming path`, () => {
    // A count is safe to log; a data URL, a filename or a placeholder body is
    // not. The slimming block must not serialize the rewritten messages.
    const source = fs.readFileSync(route, 'utf8')
    const at = source.indexOf('imageCharsSlimmed')
    assert.notEqual(at, -1, `${route} should log imageCharsSlimmed`)
    const window = source.slice(Math.max(0, at - 900), at + 300)
    assert.doesNotMatch(
      window,
      /imageSlimMessages|imageSlimPayload|placeholder:\s*imageSlim/i,
      `${route} appears to log image content alongside the counters`,
    )
  })
}
