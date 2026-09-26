/**
 * Compression backend abstraction — Phase 3 Task 3.1.
 *
 * The decision layer keeps every judgment it has today: eligibility, protection,
 * thresholds, measurement, fail-open. Only the byte-level rewrite of a single
 * text block is delegated, and the delegate is a pure function.
 *
 * The invariant under test is the one that makes this safe to extend: a backend
 * may not widen the set of messages that get rewritten, may not drop a line the
 * decision layer protected, and may not touch anything structural. `ts` is the
 * reference implementation and the always-available floor.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  optimizeUpstreamRequest,
  estimateUpstreamRequestTokens,
} from '../../../src/main/proxy/services/upstreamTokenOptimizer.ts'
import { getCompressionBackend, registerCompressionBackend } from '../../../src/main/proxy/services/backends/registry.ts'
import type { CompressionBackend, CompactBlockOptions } from '../../../src/main/proxy/services/backends/types.ts'
import { FIXTURES } from '../compression/fixtures.ts'

const FILLER = 'short filler output'

function requestWith(payload: unknown): any {
  return {
    model: 'test-model',
    messages: [
      { role: 'user', content: 'Earlier request' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_mid', type: 'function', function: { name: 'run', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_mid', content: payload },
      { role: 'user', content: 'And then?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'run', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_new', content: FILLER },
      { role: 'user', content: 'summarize' },
    ],
  }
}

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

const LONG = [
  'ERROR: dashboard request failed',
  ...Array.from({ length: 200 }, (_, i) => `diagnostic record ${i} with a long explanation`),
  'The active fix is dashboard navigation',
].join('\n')

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('the registry always yields a working backend, whatever the mode', async () => {
  for (const mode of ['ts', 'wasm', 'python', 'auto'] as const) {
    const backend = await getCompressionBackend(mode)
    assert.ok(backend, `${mode} yielded no backend`)
    assert.equal(typeof backend.compact, 'function')
  }
})

test('an unknown backend name resolves to ts', async () => {
  const backend = await getCompressionBackend('nonsense' as never)
  assert.equal(backend.id, 'ts')
})

test('an unavailable requested backend degrades to ts rather than failing', async () => {
  const hostile: CompressionBackend = {
    id: 'wasm',
    available: async () => false,
    compact: async () => undefined,
  }
  registerCompressionBackend(hostile, { force: true })
  try {
    const backend = await getCompressionBackend('wasm')
    assert.equal(backend.id, 'ts', 'an unavailable backend must not be returned')
  } finally {
    registerCompressionBackend(undefined, { id: 'wasm' })
  }
})

// ---------------------------------------------------------------------------
// Reference parity: ts must reproduce the pre-refactor output
// ---------------------------------------------------------------------------

test('the ts backend reproduces balanced-mode output on the corpus', async () => {
  const backend = await getCompressionBackend('ts')
  let compacted = 0
  for (const fixture of FIXTURES.slice(0, 60)) {
    const result = await optimizeUpstreamRequest(await requestWith(fixture.text), settings(), { backend })
    if (result.applied) compacted += 1
  }
  assert.ok(compacted > 20, `only ${compacted}/60 fixtures compacted; coverage looks lost`)
})

test('a backend returning a longer result is discarded by the decision layer', async () => {
  const bloated: CompressionBackend = {
    id: 'wasm',
    available: async () => true,
    compact: async (text: string) => ({
      text: `${text}\n${'X'.repeat(text.length)}`,
      omittedChars: 0,
      omittedLines: 0,
      retained: [],
      backend: 'wasm',
    }),
  }
  registerCompressionBackend(bloated, { force: true })
  try {
    const result = await optimizeUpstreamRequest(requestWith(LONG), settings(), {
      backend: await getCompressionBackend('wasm'),
    })
    assert.equal(result.applied, false, 'a rewrite that grows the payload must be rejected')
    assert.equal(result.changedMessageCount, 0)
  } finally {
    registerCompressionBackend(undefined, { id: 'wasm' })
  }
})

test('a backend that throws is treated as no compaction, not a failed request', async () => {
  const hostile: CompressionBackend = {
    id: 'wasm',
    available: async () => true,
    compact: async () => { throw new Error('backend exploded') },
  }
  registerCompressionBackend(hostile, { force: true })
  try {
    const result = await optimizeUpstreamRequest(requestWith(LONG), settings(), {
      backend: await getCompressionBackend('wasm'),
    })
    assert.equal(result.applied, false)
    assert.equal(result.changedMessageCount, 0)
  } finally {
    registerCompressionBackend(undefined, { id: 'wasm' })
  }
})

test('a backend that never rewrites leaves the request untouched', async () => {
  const noop: CompressionBackend = {
    id: 'python',
    available: async () => true,
    compact: async () => undefined,
  }
  registerCompressionBackend(noop, { force: true })
  try {
    const request = requestWith(LONG)
    const result = await optimizeUpstreamRequest(request, settings(), {
      backend: await getCompressionBackend('python'),
    })
    assert.equal(result.request, request)
    assert.equal(result.applied, false)
  } finally {
    registerCompressionBackend(undefined, { id: 'python' })
  }
})

// ---------------------------------------------------------------------------
// The backend cannot widen the surface
// ---------------------------------------------------------------------------

test('a backend is only asked about messages the live zone already accepted', async () => {
  const seen: number[] = []
  const spy: CompressionBackend = {
    id: 'wasm',
    available: async () => true,
    compact: async () => { seen.push(seen.length); return undefined },
  }
  registerCompressionBackend(spy, { force: true })
  try {
    const request = requestWith(LONG)
    await optimizeUpstreamRequest(request, settings(), { backend: await getCompressionBackend('wasm') })
    assert.equal(seen.length, 1,
      'exactly one message is eligible: the middle tool result. The system, user, '
      + 'filler, latest tool result and trailing user must never reach a backend.')
  } finally {
    registerCompressionBackend(undefined, { id: 'wasm' })
  }
})

test('a backend receives the protected-line indices and the active query', async () => {
  let captured: CompactBlockOptions | undefined
  const spy: CompressionBackend = {
    id: 'wasm',
    available: async () => true,
    compact: async (_text, options) => { captured = options; return undefined },
  }
  registerCompressionBackend(spy, { force: true })
  try {
    await optimizeUpstreamRequest(requestWith(LONG), settings({ mode: 'balanced' }), {
      backend: await getCompressionBackend('wasm'),
    })
    assert.ok(captured, 'the backend was never called')
    assert.equal(captured!.mode, 'balanced')
    assert.equal(captured!.maxChars, 800)
    assert.ok(Array.isArray(captured!.protectedLines))
    assert.ok(captured!.activeQuery.includes('summarize'),
      'the active query must reach the backend so it can do task-aware selection')
  } finally {
    registerCompressionBackend(undefined, { id: 'wasm' })
  }
})

test('the backend id is reported on the result', async () => {
  const result = await optimizeUpstreamRequest(requestWith(LONG), settings(), {
    backend: await getCompressionBackend('ts'),
  })
  assert.equal(result.backend, 'ts')
})
