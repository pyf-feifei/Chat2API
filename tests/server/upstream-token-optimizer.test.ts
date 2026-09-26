import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  estimateUpstreamRequestTokens,
  getUpstreamTokenOptimizerSettings,
  optimizeUpstreamRequest,
} from '../../src/main/proxy/services/upstreamTokenOptimizer.ts'

/**
 * Behavior note for every test in this file.
 *
 * The live zone protects the LATEST tool message unconditionally, so a request
 * shaped `[tool, user]` has nothing to compress no matter what `recentMessages`
 * says. An earlier version of this file used that two-message shape throughout
 * and set `recentMessages: 0` or `1` to reach the tool payload. Under the
 * pre-Phase-1 rule that worked; under the live zone it correctly does not, and
 * `applied` came back false.
 *
 * The rule is right and the shapes were wrong. Every test that wants to observe
 * a compaction now uses `requestWithMiddleToolPayload`, which puts the payload
 * in the middle of three tool turns. The new rule has its own test below.
 */

const baseRequest = (messages: any[]) => ({ model: 'test-model', messages })

const LATER_OUTPUT = 'short filler output from a later tool turn'

/** Put `content` in an eligible position: a completed, paired, non-latest tool result. */
function requestWithMiddleToolPayload(content: unknown, trailingUser = 'Continue'): any {
  return baseRequest([
    { role: 'user', content: 'Earlier request' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_mid', type: 'function', function: { name: 'run', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_mid', content },
    { role: 'user', content: 'And then?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'run', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_new', content: LATER_OUTPUT },
    { role: 'user', content: trailingUser },
  ])
}

test('token optimizer is disabled by default and modes are opt-in', () => {
  assert.equal(getUpstreamTokenOptimizerSettings({}).mode, 'off')
  assert.equal(getUpstreamTokenOptimizerSettings({
    CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'safe',
  }).mode, 'safe')
  assert.equal(getUpstreamTokenOptimizerSettings({
    CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'dry-run',
  }).mode, 'dry-run')
  assert.equal(getUpstreamTokenOptimizerSettings({
    CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'balanced',
  }).mode, 'balanced')
  assert.equal(getUpstreamTokenOptimizerSettings({
    CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'not-a-mode',
  }).mode, 'off')
})

test('the live zone protects the latest tool result even at recentMessages 0', async () => {
  // The behavior change Phase 1 introduces. Before it, `recentMessages: 0`
  // meant "every tool message is eligible", and the newest one got rewritten.
  const request = baseRequest([
    { role: 'tool', content: 'progress tick\n'.repeat(200) },
    { role: 'user', content: 'Continue' },
  ])
  const result = await optimizeUpstreamRequest(request, {
    mode: 'safe',
    minEstimatedTokens: 0,
    recentMessages: 0,
    minEstimatedSavings: 1,
  })

  assert.equal(result.request, request, 'the request must be returned untouched')
  assert.equal(result.applied, false)
  assert.equal(result.changedMessageCount, 0)
})

test('safe mode compacts repeated old tool lines without mutating the input', async () => {
  const originalContent = `${'progress: downloading package\n'.repeat(100)}`
  const request = requestWithMiddleToolPayload(originalContent)
  const before = request.messages[2].content
  const result = await optimizeUpstreamRequest(request, {
    mode: 'safe',
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
  })

  assert.equal(result.applied, true)
  assert.equal(result.compressedRunCount, 1)
  assert.equal(result.changedMessageCount, 1)
  assert.ok(result.estimatedTokensSaved > 0)
  assert.notEqual(result.request, request)
  assert.equal(request.messages[2].content, before, 'the input must not be mutated')
  assert.match(result.request.messages[2].content, /progress: downloading package/)
  assert.match(result.request.messages[2].content, /\[Chat2API repeated identical line x100\]/)
  assert.ok(
    !result.request.messages[2].content.includes('progress: downloading package\nprogress: downloading package'),
  )
})

test('valid JSON tool output is compacted while preserving parsed data', async () => {
  const value = { status: 'ok', values: [1, 2, 3], nested: { keep: 'all values' } }
  const content = JSON.stringify(value, null, 4)
  const request = requestWithMiddleToolPayload(content)
  const result = await optimizeUpstreamRequest(request, {
    mode: 'safe',
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
  })

  assert.equal(result.applied, true)
  assert.equal(result.compactedJsonMessageCount, 1)
  assert.deepEqual(JSON.parse(result.request.messages[2].content), value)
  assert.ok(result.request.messages[2].content.length < content.length)
})

test('dry-run reports savings but returns the original request', async () => {
  const request = requestWithMiddleToolPayload('progress tick\n'.repeat(80))
  const result = await optimizeUpstreamRequest(request, {
    mode: 'dry-run',
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
  })

  assert.equal(result.applied, false)
  assert.equal(result.request, request)
  assert.equal(result.estimatedInputTokensAfter, result.estimatedInputTokensBefore)
  assert.ok(result.candidateTokensSaved > 0, 'dry-run must still measure the configured backend')
  assert.equal(result.skipReason, 'dry_run')
})

test('safe mode protects recent, error, and source tool content', async () => {
  const repeated = 'progress tick\n'.repeat(80)
  const code = '```ts\nconst same = true\nconst same = true\nconst same = true\n```'
  const request = baseRequest([
    { role: 'system', content: repeated },
    { role: 'tool', tool_call_id: 'call_error', is_error: true, content: 'ERROR: failure\n'.repeat(80) },
    { role: 'tool', tool_call_id: 'call_code', content: code },
    { role: 'tool', tool_call_id: 'call_recent', content: repeated },
  ])
  const result = await optimizeUpstreamRequest(request, {
    mode: 'safe',
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
  })

  assert.equal(result.applied, false)
  assert.equal(result.request, request)
  assert.equal(result.candidateTokensSaved, 0)
})

test('balanced mode keeps critical/query lines and bounds old tool text', async () => {
  const oldToolText = [
    'ERROR: dashboard request failed',
    ...Array.from({ length: 120 }, (_, index) => `diagnostic record ${index} with a long explanation`),
    'The active fix is dashboard navigation',
    'path=C:/workspace/dashboard.ts',
  ].join('\n')
  const request = requestWithMiddleToolPayload(oldToolText, 'Please fix dashboard navigation')
  const result = await optimizeUpstreamRequest(request, {
    mode: 'balanced',
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
    maxToolTextChars: 1_000,
  })

  assert.equal(result.applied, true)
  assert.equal(result.balancedMessageCount, 1)
  assert.ok(result.balancedOmittedChars > 0)
  const compacted = result.request.messages[2].content
  assert.match(compacted, /omitted tool output/)
  assert.match(compacted, /ERROR: dashboard request failed/)
  assert.match(compacted, /dashboard navigation/)
  assert.match(compacted, /path=C:\/workspace\/dashboard\.ts/)
  assert.ok(compacted.length <= 1_000)
  assert.equal(request.messages[2].content, oldToolText, 'the input must not be mutated')
})

test('the repository tool-heavy fixture shows measurable balanced-mode savings', async () => {
  const fixture = JSON.parse(fs.readFileSync('.testimg/req_real.json', 'utf8'))
  // The repository fixture intentionally contains standalone tool-result
  // messages. Remove their orphan IDs so this test exercises the eligible
  // tool-payload path rather than the unresolved/orphan safety gate.
  fixture.messages = fixture.messages.map((message: any) => {
    if (message.role !== 'tool') return message
    const { tool_call_id: _toolCallId, ...rest } = message
    return rest
  })
  // The fixture ends on a user message whose tool results all precede it, so the
  // live zone's latest-tool protection is satisfied by the request shape. What
  // changed in Phase 1 is only that the floor comes from cache_control, which
  // this fixture does not send.
  const result = await optimizeUpstreamRequest(fixture, {
    mode: 'balanced',
    minEstimatedTokens: 0,
    recentMessages: 8,
    minEstimatedSavings: 1,
    maxToolTextChars: 4_000,
  })

  assert.equal(result.applied, true)
  assert.ok(result.estimatedTokensSaved > 0)
  assert.ok(result.balancedMessageCount > 0)
  assert.ok(result.estimatedInputTokensAfter < result.estimatedInputTokensBefore)
  assert.equal(result.liveZoneSource, 'recent-window')
})

test('below-threshold requests are never rewritten', async () => {
  const request = requestWithMiddleToolPayload('same line\n'.repeat(100))
  const before = estimateUpstreamRequestTokens(request)
  const result = await optimizeUpstreamRequest(request, {
    mode: 'safe',
    minEstimatedTokens: before + 1,
    recentMessages: 1,
    minEstimatedSavings: 1,
  })

  assert.equal(result.applied, false)
  assert.equal(result.request, request)
  assert.equal(result.estimatedInputTokensBefore, before)
  assert.equal(result.estimatedInputTokensAfter, before)
  assert.equal(result.skipReason, 'below_min_estimated_tokens')
})

test('non-text multimodal content is preserved', async () => {
  const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const textPart = { type: 'text', text: 'progress tick\n'.repeat(100) }
  const request = requestWithMiddleToolPayload([imagePart, textPart])
  const result = await optimizeUpstreamRequest(request, {
    mode: 'safe',
    minEstimatedTokens: 0,
    recentMessages: 1,
    minEstimatedSavings: 1,
  })

  assert.equal(result.applied, true)
  assert.equal(result.request.messages[2].content[0], imagePart, 'the image part must be untouched')
  assert.match(result.request.messages[2].content[1].text, /repeated identical line/)
})
