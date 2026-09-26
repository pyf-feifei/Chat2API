/**
 * CCR integration — Phase 2 Task 2.2.
 *
 * Task 2.1 built the store. This file pins the two rules that make it more than
 * a data structure:
 *
 *   1. `safe` mode writes NOTHING. It is information-preserving, so a
 *      retrievable archive for it would be pure overhead on disk.
 *   2. `balanced` writes only what it actually dropped, and the marker carries
 *      the hash so the model can ask for exactly that back.
 *
 * The archive is injected so the tests do not touch the filesystem or the
 * runtime's data directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { optimizeUpstreamRequest } from '../../../src/main/proxy/services/upstreamTokenOptimizer.ts'
import { CompressionArchive } from '../../../src/main/proxy/services/compressionArchive.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../../src/main/proxy/types.ts'

const SCOPE = 'qwen-ai:account-1:session-7'

function settings(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'balanced' as const,
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
    maxToolTextChars: 800,
    frozenPrefixMessages: 0,
    ...overrides,
  }
}

const FILLER = 'short filler output'

async function requestWith(payload: unknown): ChatCompletionRequest {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Earlier request' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_mid', type: 'function', function: { name: 'run', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_mid', content: payload },
    { role: 'user', content: 'And then?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'run', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_new', content: FILLER },
    { role: 'user', content: 'summarize' },
  ]
  return { model: 'test-model', messages } as ChatCompletionRequest
}

const LONG_TOOL_TEXT = [
  'ERROR: dashboard request failed',
  ...Array.from({ length: 200 }, (_, index) => `diagnostic record ${index} with a long explanation`),
  'The active fix is dashboard navigation',
].join('\n')

let archiveCounter = 0

/**
 * A fresh archive per call. An earlier version used a fixed temp filename, and
 * because the store is file-backed the entries accumulated across tests, so
 * "this test wrote nothing" failed for entries an earlier test had written.
 */
function archive(maxChars = 1_000_000) {
  archiveCounter += 1
  return new CompressionArchive({
    filePath: `${os.tmpdir()}\\chat2api-crr-${process.pid}-${archiveCounter}.json`,
    ttlMs: 60_000,
    maxChars,
    now: () => 1_000,
  })
}

test('safe mode writes nothing to the archive', async () => {
  // The payload must be one safe mode WILL rewrite, otherwise `applied` is false
  // for an unrelated reason and the test proves nothing. Repeated log lines are
  // collapsed by `compactToolText` without losing information.
  const store = archive()
  const request = await requestWith('progress tick\n'.repeat(200))
  const result = await optimizeUpstreamRequest(request, {
    ...settings(),
    mode: 'safe',
  }, { archive: store, scope: SCOPE })

  assert.equal(result.applied, true, 'safe mode should still collapse the repeated lines')
  assert.equal(result.archivedCount, 0)
  assert.equal(result.archivedChars, 0)
  assert.equal(store.stats().entries, 0, 'safe mode must not write to disk')
})

test('balanced mode archives what it dropped and reports counts, never hashes on the result', async () => {
  const store = archive()
  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings(), {
    archive: store,
    scope: SCOPE,
  })

  assert.equal(result.applied, true)
  assert.equal(result.balancedMessageCount, 1)
  assert.equal(result.archivedCount, 1)
  assert.ok(result.archivedChars > 0, 'the dropped span should be counted')

  // The result must not carry a hash. A hash identifies tool output that may
  // contain credentials or file contents, and this object reaches the log line.
  // An earlier version of this test searched the serialized result for the
  // archive's char count, which is a bare digit substring and proves nothing.
  assert.doesNotMatch(
    JSON.stringify(result),
    /"[0-9a-f]{16}"/,
    'no 16-hex value may appear anywhere on the result object',
  )
  assert.deepEqual(
    Object.keys(result).filter((key) => /archive/i.test(key)),
    ['archivedCount', 'archivedChars'],
    'the archive fields are counts only',
  )
})

test('the omission marker names the retrieval tool and carries the hash', async () => {
  const store = archive()
  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings(), { archive: store, scope: SCOPE })

  const compacted = result.request.messages[2].content as string
  assert.match(compacted, /archive:tool:[0-9a-f]{16}/,
    'the marker must carry a content hash the model can quote back')
  assert.match(compacted, /retrieve_tool_output/,
    'the marker must tell the model how to get the span back')
})

test('the archived text is the omitted portion, and retrieving it returns exactly that', async () => {
  const store = archive()
  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings(), { archive: store, scope: SCOPE })

  const compacted = result.request.messages[2].content as string
  const hash = /archive:tool:([0-9a-f]{16})/.exec(compacted)![1]
  const recovered = store.resolve(SCOPE, hash)

  assert.ok(recovered, 'the hash in the marker must resolve')
  assert.ok(recovered!.includes('diagnostic record 100'),
    'the recovered text should be the omitted span, not the whole block')

  // Retained lines are still inline, so a retrieval must not duplicate them.
  const inlineLines = new Set(compacted.split('\n'))
  for (const line of recovered!.split('\n')) {
    if (line.includes('diagnostic record')) {
      assert.equal(inlineLines.has(line), false,
        'an omitted line must not also survive inline')
    }
  }
  assert.ok(compacted.includes('ERROR: dashboard request failed'), 'critical lines stay inline')
})

test('critical and query-matching lines are never archived away silently', async () => {
  const store = archive()
  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings(), { archive: store, scope: SCOPE })
  const compacted = result.request.messages[2].content as string

  assert.match(compacted, /ERROR: dashboard request failed/)
  assert.match(compacted, /dashboard navigation/)
})

test('without an archive the optimizer still compacts, just without a retrieval key', async () => {
  // The archive is an enhancement. A deployment that has not enabled it, or a
  // store that failed to load, must still get the token saving.
  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings())

  assert.equal(result.applied, true)
  assert.equal(result.archivedCount, 0)
  const compacted = result.request.messages[2].content as string
  assert.match(compacted, /omitted tool output/, 'the plain marker is still emitted')
  assert.doesNotMatch(compacted, /archive:tool:/, 'with no archive there is nothing to point at')
})

test('an archive that refuses to store degrades to the plain marker', async () => {
  // `maxChars: 1` makes every record unstoreable. The rewrite must still apply
  // rather than falling back to the original request.
  const store = archive(1)
  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings(), { archive: store, scope: SCOPE })

  assert.equal(result.applied, true)
  assert.equal(result.archivedCount, 0)
  assert.match(result.request.messages[2].content as string, /omitted tool output/)
})

test('an archive that throws does not fail the request', async () => {
  const hostile = {
    record() { throw new Error('disk on fire') },
    resolve() { return undefined },
    forget() {},
    stats() { return { entries: 0, chars: 0, maxChars: 0, ttlMs: 0 } },
  } as unknown as CompressionArchive

  const request = await requestWith(LONG_TOOL_TEXT)
  const result = await optimizeUpstreamRequest(request, settings(), { archive: hostile, scope: SCOPE })

  assert.equal(result.applied, true, 'compression is an optimization, never a dependency')
  assert.match(result.request.messages[2].content as string, /omitted tool output/)
})

test('balanced mode with no omission archives nothing', async () => {
  // A block at or below maxChars is left alone entirely.
  const store = archive()
  const request = await requestWith('tiny output')
  const result = await optimizeUpstreamRequest(request, settings(), { archive: store, scope: SCOPE })

  assert.equal(result.archivedCount, 0)
  assert.equal(store.stats().entries, 0)
})
