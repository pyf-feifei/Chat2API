import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extensionForMimeType,
  extractMimoPlainText,
  isHttpUrl,
  mimoFileOffloadThresholdChars,
  mimoMediaMaxBytes,
  mimoMediaMaxItems,
  mimoMediaParseModels,
  mimoRequestTimeoutMs,
  mimoUploadSettleMs,
  mimoUploadTimeoutMs,
  parseMimoDataUrl,
  planMimoFileOffload,
  prepareMimoAttachments,
  compactMimoMessagesForQuery,
  splitMimoContentParts,
} from '../../src/main/proxy/adapters/mimo-files.ts'

const CREDENTIALS = { serviceToken: 'svc', userId: '1', phToken: 'ph' }

test('parseMimoDataUrl accepts base64 payloads and rejects the rest', () => {
  const parsed = parseMimoDataUrl('data:image/png;base64,AAAA')
  assert.deepEqual(parsed, { mimeType: 'image/png', base64: 'AAAA' })
  assert.equal(parseMimoDataUrl('data:image/png,raw'), null)
  assert.equal(parseMimoDataUrl('https://example.com/a.png'), null)
  assert.equal(parseMimoDataUrl(''), null)
  assert.equal(parseMimoDataUrl('data:image/png;base64,'), null)
})

test('isHttpUrl only accepts http(s) targets', () => {
  assert.equal(isHttpUrl('https://example.com/a.png'), true)
  assert.equal(isHttpUrl('HTTP://example.com/a.png'), true)
  assert.equal(isHttpUrl('ftp://example.com/a.png'), false)
  assert.equal(isHttpUrl('data:image/png;base64,AA'), false)
})

test('splitMimoContentParts keeps text and classifies image/file parts', () => {
  const split = splitMimoContentParts([
    { type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'file', file: { filename: 'notes.md', file_data: 'data:text/markdown;base64,WFla' } },
    { type: 'audio', audio_url: { url: 'https://example.com/a.mp3' } },
  ])

  assert.equal(split.text, 'describe')
  assert.equal(split.media.length, 3)
  assert.deepEqual(split.media[0], { kind: 'image', base64: 'QUJD', mimeType: 'image/jpeg', fileName: undefined })
  assert.deepEqual(split.media[1], { kind: 'image', url: 'https://example.com/a.png' })
  assert.equal(split.media[2].kind, 'file')
  assert.equal(split.media[2].fileName, 'notes.md')
})

test('splitMimoContentParts passes plain strings through and tolerates junk', () => {
  assert.deepEqual(splitMimoContentParts('hello'), { text: 'hello', media: [] })
  assert.deepEqual(splitMimoContentParts(null), { text: '', media: [] })
  assert.deepEqual(splitMimoContentParts([null, 42, { type: 'text', text: 'ok' }]), {
    text: 'ok',
    media: [],
  })
})

test('extractMimoPlainText ignores media parts', () => {
  const text = extractMimoPlainText([
    { type: 'text', text: 'line one' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'text', text: 'line two' },
  ])
  assert.equal(text, 'line one\nline two')
})

test('planMimoFileOffload keeps everything below the threshold', () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(1_000) },
    { role: 'assistant', content: 'b'.repeat(1_000) },
  ]
  const plan = planMimoFileOffload(messages, 60_000)
  assert.deepEqual(plan.offloadIndexes, [])
  assert.equal(plan.remainingChars, 2_000)
})

test('planMimoFileOffload offloads the largest messages first', () => {
  const messages = [
    { role: 'user', content: 'q'.repeat(1_000) },
    { role: 'assistant', content: 'h'.repeat(40_000) },
    { role: 'user', content: 'z'.repeat(30_000) },
  ]
  const plan = planMimoFileOffload(messages, 20_000)
  assert.deepEqual(plan.offloadIndexes, [1, 2])
  assert.equal(plan.remainingChars, 1_000)
})

test('planMimoFileOffload never offloads tiny messages and can be disabled', () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(1_500) },
    { role: 'user', content: 'b'.repeat(1_500) },
  ]
  assert.deepEqual(planMimoFileOffload(messages, 1_000).offloadIndexes, [])
  assert.deepEqual(planMimoFileOffload(messages, 0).offloadIndexes, [])
})

test('planMimoFileOffload keeps protected system and active messages inline', () => {
  const messages = [
    { role: 'system', content: 'Available Tools\n<|CHAT2API|tool_calls>'.repeat(20_000) },
    { role: 'user', content: 'old context '.repeat(20_000) },
    { role: 'user', content: 'current request' },
  ]
  const plan = planMimoFileOffload(messages, 1_000, new Set([0, 2]))
  assert.deepEqual(plan.offloadIndexes, [1])
})

test('query compaction preserves the active turn and current instruction', () => {
  const messages = [
    { role: 'system', content: 'tool contract '.repeat(20_000) },
    ...Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: 'old '.repeat(1_000) + index })),
    { role: 'user', content: 'current request' },
  ]
  const result = compactMimoMessagesForQuery(messages, 32_000)
  assert.equal(result.compacted, true)
  assert.ok(result.afterChars < result.beforeChars)
  assert.equal(result.messages.at(-1)?.content, 'current request')
  assert.match(String(result.messages[0].content), /tool contract/)
})

test('long transcripts offload small old messages when aggregate size still exceeds the limit', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index === 19 ? 'user' : 'assistant',
    content: 'x'.repeat(100),
  }))
  const plan = planMimoFileOffload(messages, 50, new Set([19]))
  assert.ok(plan.offloadIndexes.length > 0)
  assert.equal(plan.remainingChars, 100)
})

test('environment knobs fall back to documented defaults', () => {
  assert.equal(mimoFileOffloadThresholdChars({}), 8_000)
  assert.equal(mimoFileOffloadThresholdChars({ MIMO_FILE_OFFLOAD_THRESHOLD_CHARS: '120000' }), 120_000)
  assert.equal(mimoFileOffloadThresholdChars({ MIMO_FILE_OFFLOAD_THRESHOLD_CHARS: 'nope' }), 8_000)
  assert.equal(mimoMediaMaxBytes({}), 10 * 1024 * 1024)
  assert.equal(mimoMediaMaxBytes({ MIMO_MEDIA_MAX_BYTES: '1024' }), 1024)
  assert.equal(mimoMediaMaxItems({ MIMO_MEDIA_MAX_ITEMS: '2' }), 2)
  assert.equal(mimoUploadTimeoutMs({ MIMO_UPLOAD_TIMEOUT_MS: '30000' }), 30_000)
  assert.equal(mimoUploadSettleMs({}), 3_000)
  assert.equal(mimoUploadSettleMs({ MIMO_UPLOAD_SETTLE_MS: '0' }), 0)
  assert.deepEqual(mimoMediaParseModels({}), ['mimo-v2.6-flash', 'mimo-v2.5'])
  assert.deepEqual(mimoMediaParseModels({ MIMO_MEDIA_PARSE_MODELS: 'a, b' }), ['a', 'b'])
  assert.equal(mimoRequestTimeoutMs({ MIMO_REQUEST_TIMEOUT_MS: '60000' }), 60_000)
  assert.equal(mimoRequestTimeoutMs({}), 300_000)
})

test('extensionForMimeType maps common upload types', () => {
  assert.equal(extensionForMimeType('image/jpeg'), 'jpg')
  assert.equal(extensionForMimeType('image/png'), 'png')
  assert.equal(extensionForMimeType('text/markdown'), 'md')
  assert.equal(extensionForMimeType('application/json'), 'json')
  assert.equal(extensionForMimeType('application/octet-stream'), 'txt')
})

test('prepareMimoAttachments leaves text-only requests untouched without network calls', async () => {
  const messages = [{ role: 'user', content: 'hello' }]
  const result = await prepareMimoAttachments({
    messages,
    credentials: CREDENTIALS,
    model: 'mimo-v2.6-flash',
    env: {},
  })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0], messages[0])
  assert.deepEqual(result.multiMedias, [])
  assert.deepEqual(result.offloadedFiles, [])
})

test('prepareMimoAttachments rejects oversized inline media before any upload', async () => {
  await assert.rejects(
    prepareMimoAttachments({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(64)}` } },
        ],
      }],
      credentials: CREDENTIALS,
      model: 'mimo-v2.6-flash',
      env: { MIMO_MEDIA_MAX_BYTES: '8' },
    }),
    /exceeds the 8 byte limit/,
  )
})
