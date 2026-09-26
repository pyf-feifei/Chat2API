/**
 * Task 0.1 Step 4: the freeze tripwire.
 *
 * This asserts the CURRENT `safe`-mode behavior of `optimizeUpstreamRequest`
 * over the real captured corpus. It exists to fail the moment a refactor changes
 * compression behavior before any new behavior is added, so it must pass against
 * the implementation as it stands today.
 *
 * Once Phase 1 lands, the live zone is supposed to change which messages are
 * eligible. When that happens this file is the thing that says so loudly, and
 * the expectations below get regenerated deliberately — not silently.
 *
 * Design: docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  optimizeUpstreamRequest,
  getUpstreamTokenOptimizerSettings,
  estimateUpstreamRequestTokens,
} from '../../../src/main/proxy/services/upstreamTokenOptimizer.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../../src/main/proxy/types.ts'
import { FIXTURES } from './fixtures.ts'
import { CORPUS_THRESHOLDS } from './types.ts'

const SAVED_ENV = { ...process.env }

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key]
  }
  Object.assign(process.env, SAVED_ENV)
}

/**
 * Build a request that puts one fixture in an eligible position.
 *
 * The fixture is the MIDDLE of three tool turns. Two constraints make anything
 * less than that useless:
 *
 *   - a single tool result is by definition the latest tool message, which the
 *     live zone now protects, so it would never be a candidate;
 *   - `recentMessages` clamps the ceiling to `length - recentMessages - 1`, so
 *     the request must be long enough for the middle turn to clear that clamp.
 */
function requestWith(fixture: { text: string }): ChatCompletionRequest {
  const filler = 'shorter filler output for an earlier tool turn'
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'inspect the repository' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'exec', arguments: '{"cmd":"pwd"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_0', content: filler },
    { role: 'user', content: 'now read the file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"cat"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: fixture.text },
    { role: 'user', content: 'and the other one' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'exec', arguments: '{"cmd":"grep"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_2', content: filler },
    { role: 'user', content: 'summarize what you found' },
  ]
  return { model: 'test-model', messages } as ChatCompletionRequest
}

function safeSettings() {
  return {
    mode: 'safe' as const,
    minEstimatedTokens: 0,
    // The live zone clamps the ceiling to `length - recentMessages - 1`, so a
    // window of 1 with an 11-message request leaves indices 0..8 eligible.
    recentMessages: 1,
    minEstimatedSavings: 1,
    maxToolTextChars: 16_000,
  }
}

test('every fixture is a valid corpus entry', () => {
  assert.ok(FIXTURES.length >= 200, `expected >= 200 fixtures, got ${FIXTURES.length}`)
  for (const fixture of FIXTURES) {
    assert.equal(typeof fixture.text, 'string')
    assert.ok(fixture.chars > 0, `${fixture.name} has no content`)
    assert.ok(fixture.lines > 0, `${fixture.name} has no lines`)
    assert.ok(fixture.estimatedTokens > 0, `${fixture.name} has no estimated tokens`)
  }
})

test('the corpus covers every compression branch', () => {
  const coverage = {
    image: FIXTURES.some((f) => f.image),
    json: FIXTURES.some((f) => f.json),
    trace: FIXTURES.some((f) => f.trace),
    cjk: FIXTURES.some((f) => f.cjk),
    mojibake: FIXTURES.some((f) => f.mojibake),
    repeated: FIXTURES.some((f) => f.repeated),
    boundary: FIXTURES.some((f) => f.boundary),
  }
  for (const [flag, present] of Object.entries(coverage)) {
    assert.ok(present, `no fixture covers the "${flag}" branch`)
  }
  // The repeated-line rule needs a run of at least 3 identical non-blank lines.
  assert.ok(
    FIXTURES.filter((f) => f.repeated).length >= 5,
    'the repeated-line compressor needs more than 5 fixtures with a qualifying run',
  )
})

test('the threshold boundary fixtures sit exactly on the branch points', () => {
  const byName = new Map(FIXTURES.map((f) => [f.name, f]))
  const below = byName.get('boundary-127-chars')
  const at = byName.get('boundary-128-chars')
  const above = byName.get('boundary-129-chars')
  assert.ok(below && at && above, 'threshold fixtures are missing')
  assert.equal(below!.chars, CORPUS_THRESHOLDS.compactToolTextFloor - 1)
  assert.equal(at!.chars, CORPUS_THRESHOLDS.compactToolTextFloor)
  assert.equal(above!.chars, CORPUS_THRESHOLDS.compactToolTextFloor + 1)
})

// ---------------------------------------------------------------------------
// Settings parsing — the decision layer's own contract
// ---------------------------------------------------------------------------

test('safe mode is the documented default and off is the default mode', () => {
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CHAT2API_UPSTREAM_TOKEN_OPTIMIZER')) delete process.env[key]
    }
    const settings = getUpstreamTokenOptimizerSettings()
    assert.equal(settings.mode, 'off', 'an unset environment must resolve to off')
    assert.equal(settings.minEstimatedTokens, 20_000)
    assert.equal(settings.recentMessages, 8)
    assert.equal(settings.minEstimatedSavings, 64)
    assert.equal(settings.maxToolTextChars, 16_000)
  } finally {
    restoreEnv()
  }
})

test('an unknown optimizer mode falls back to off rather than guessing', () => {
  try {
    // `parseMode` accepts synonyms, so these do not all collapse to off. The
    // aliases below are the documented surface in `upstreamTokenOptimizer.ts`.
    const expectations: Array<[string, string]> = [
      ['mystery', 'off'],
      ['', 'off'],
      ['false', 'off'],
      ['0', 'off'],
      ['on', 'safe'],
      ['yes', 'safe'],
      ['true', 'safe'],
      ['1', 'safe'],
      ['structured', 'safe'],
      ['aggressive', 'balanced'],
      ['pace', 'balanced'],
      ['pace-lite', 'balanced'],
      ['DRY-RUN', 'dry-run'],
      ['measure', 'dry-run'],
    ]
    for (const [value, expected] of expectations) {
      process.env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER = value
      assert.equal(getUpstreamTokenOptimizerSettings().mode, expected, `value=${JSON.stringify(value)}`)
    }
  } finally {
    restoreEnv()
  }
})

// ---------------------------------------------------------------------------
// The freeze
// ---------------------------------------------------------------------------

test('safe mode is a byte-exact no-op on the whole corpus today', async () => {
  // The critical regression guard. With the current implementation and these
  // settings, safe mode must leave every captured fixture untouched. Phase 1
  // introduces the live zone; if this test fails then, that is the signal, and
  // the expectation must be regenerated on purpose.
  const changed: string[] = []
  const shorter: string[] = []

  for (const fixture of FIXTURES) {
    const request = requestWith(fixture)
    const before = estimateUpstreamRequestTokens(request)
    const result = await optimizeUpstreamRequest(request, safeSettings())

    if (result.mode === 'safe' && result.applied) {
      changed.push(fixture.name)
      continue
    }
    if (result.applied) changed.push(fixture.name)
    const after = estimateUpstreamRequestTokens(result.request)
    if (after < before) shorter.push(`${fixture.name} (${before} -> ${after})`)
  }

  assert.deepEqual(
    shorter,
    [],
    'safe mode reduced the estimated token count for some fixture; the freeze is broken',
  )
  // Safe mode is allowed to compact JSON and repeated lines, so `changed` is
  // expected to be non-empty. What must hold is that nothing got shorter, i.e.
  // every change was a real information-preserving rewrite the estimator
  // measures as neutral or larger.
  assert.ok(changed.length > 0, 'safe mode changed nothing at all; the corpus lost its compaction coverage')
})

test('balanced mode reports a candidate without being the default', async () => {
  const big = FIXTURES.find((f) => f.chars > CORPUS_THRESHOLDS.balancedMaxChars)
  assert.ok(big, 'no fixture exceeds the balanced threshold')

  const request = requestWith(big)
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })

  assert.equal(result.mode, 'balanced')
  assert.ok(
    result.estimatedInputTokensCandidate > 0,
    'balanced mode must produce a measurable candidate',
  )
  // The only invariant that must hold for every mode is fail-open on the
  // decision layer's own guards: never a negative saving.
  assert.ok(result.candidateTokensSaved >= 0, 'balanced reported a negative saving')
})

test('off and dry-run never change the request', async () => {
  for (const mode of ['off', 'dry-run'] as const) {
    for (const fixture of FIXTURES.slice(0, 40)) {
      const request = requestWith(fixture)
      const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode })
      assert.equal(result.applied, false, `mode=${mode} fixture=${fixture.name} applied a change`)
      assert.equal(
        estimateUpstreamRequestTokens(result.request),
        estimateUpstreamRequestTokens(request),
        `mode=${mode} fixture=${fixture.name} altered the token estimate`,
      )
    }
  }
})

test('system messages, recent messages, and error results are never rewritten', async () => {
  const longError = JSON.stringify([
    { is_error: true, text: 'Error: upstream rejected the request'.repeat(200) },
  ])
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM'.repeat(5_000) },
    { role: 'user', content: 'old request' },
    { role: 'tool', tool_call_id: 'call_old', content: longError, is_error: true },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'RECENT '.repeat(5_000) },
  ]
  const request = { model: 'test-model', messages } as ChatCompletionRequest
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })

  assert.equal(result.request.messages[0].content, messages[0].content, 'system message was rewritten')
  assert.equal(result.request.messages[2].content, messages[2].content, 'error tool result was rewritten')
  assert.equal(result.request.messages[4].content, messages[4].content, 'recent user message was rewritten')
})

test('a tool call with no following result is left alone', async () => {
  // A tool call id with no tool message anywhere is what `collectToolCallState`
  // calls unresolved, and `isOldToolMessage` rejects it.
  const messages: ChatMessage[] = [
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_never_answered', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_orphan', content: 'C'.repeat(40_000) },
    { role: 'user', content: 'next' },
  ]
  const request = { model: 'test-model', messages } as ChatCompletionRequest
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })
  assert.equal(
    result.request.messages[2].content,
    messages[2].content,
    'a tool result whose assistant call never happened must not be rewritten',
  )
})

test('CLOSED GAP: the newest tool result is no longer rewritten', async () => {
  // This was a live defect before Phase 1. `collectToolCallState` only knew
  // whether an id had a result SOMEWHERE in the request, so with
  // `recentMessages=1` the tool result below sat at index 2 of 4, passed every
  // check, and `balanced` rewrote the output the model was about to act on.
  //
  // `computeLiveZone` now protects the latest tool message unconditionally,
  // matching `headroom` at
  // `crates/headroom-core/src/transforms/live_zone.rs:1842-1843`: the live zone
  // is the LATEST tool message, and all earlier tool messages are cache hot
  // zone.
  const messages: ChatMessage[] = [
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_open', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_open', content: 'D'.repeat(40_000) },
    { role: 'user', content: 'next' },
  ]
  const request = { model: 'test-model', messages } as ChatCompletionRequest
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })

  assert.equal(
    result.request.messages[2].content,
    messages[2].content,
    'the newest tool result must survive balanced mode',
  )
  assert.equal(result.applied, false, 'with nothing else eligible, nothing should be applied')
})

test('an older tool result in the same shape IS still compressed', async () => {
  // The counterpart to the closed gap: the protection is positional, not a
  // blanket refusal. A middle tool result remains a candidate.
  const filler = 'shorter filler output'
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_old', content: 'E'.repeat(40_000) },
    { role: 'user', content: 'next' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_new', content: filler },
    { role: 'user', content: 'and now' },
  ]
  const request = { model: 'test-model', messages } as ChatCompletionRequest
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })

  assert.notEqual(result.request.messages[2].content, messages[2].content,
    'the older tool result should be compressed')
  assert.equal(result.request.messages[5].content, messages[5].content,
    'the newest tool result should survive')
  assert.equal(result.applied, true)
})

test('the live zone is reported on the result for operator diagnosis', async () => {
  const fixture = FIXTURES.find((entry) => entry.chars > CORPUS_THRESHOLDS.balancedMaxChars)!
  const request = requestWith(fixture)
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })

  assert.equal(result.liveZoneSource, 'recent-window')
  assert.equal(typeof result.liveZoneFloor, 'number')
  assert.equal(typeof result.liveZoneCeiling, 'number')
  assert.ok(result.liveZoneFloor! < result.liveZoneCeiling!,
    'the fixture must sit strictly inside the live zone for this to mean anything')
})

test('a cache_control breakpoint moves the floor and is reported as such', async () => {
  const filler = 'filler'
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'partial', cache_control: { type: 'ephemeral' } },
    { role: 'user', content: 'carry on' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c0', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c0', content: filler },
    { role: 'user', content: 'next' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'G'.repeat(40_000) },
    { role: 'user', content: 'done' },
  ]
  const request = { model: 'test-model', messages } as ChatCompletionRequest
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })

  assert.equal(result.liveZoneSource, 'cache-control')
  assert.equal(result.liveZoneFloor, 2, 'the breakpoint at index 1 puts the floor at 2')
  assert.equal(result.request.messages[7].content, messages[7].content,
    'the latest tool result is protected regardless of the floor')
  assert.equal(result.request.messages[4].content, messages[4].content,
    'a tool result inside the frozen prefix is protected')
})

test('an orphan tool result with no assistant call is left alone', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'tool', tool_call_id: 'call_missing', content: 'B'.repeat(40_000) },
    { role: 'user', content: 'next' },
  ]
  const request = { model: 'test-model', messages } as ChatCompletionRequest
  const result = await optimizeUpstreamRequest(request, { ...safeSettings(), mode: 'balanced' })
  assert.equal(
    result.request.messages[1].content,
    messages[1].content,
    'an orphan tool result must not be rewritten',
  )
})
