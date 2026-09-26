/**
 * Live-zone boundary.
 *
 * Reference: `headroom/crates/headroom-core/src/transforms/live_zone.rs:1-70`
 * and the OpenAI Chat definition at `:1840-1874`:
 *
 *   "Chat Completions defines the live zone as the LATEST `role: "tool"` message
 *    and the LATEST `role: "user"` message (separately, not as a contiguous
 *    run). All earlier `tool` / `user` messages are part of the cache hot zone
 *    — never touched."
 *
 * The floor is the important half and it is cache-driven, not count-driven: a
 * byte change below the provider's prompt-cache boundary forfeits the discount
 * for the whole rest of the conversation.
 *
 * Two things this file pins deliberately:
 *
 *   - Critical Constraint 3. With no `cache_control` and no explicit floor, the
 *     eligible set must be identical to the pre-Phase-1
 *     `index < max(0, length - recentMessages)` rule. The single intentional
 *     exception is the latest-tool-result protection, which is strictly a
 *     narrowing.
 *
 *   - The ceiling and the count clamp are separate rules. `recentMessages`
 *     defaults to 8, so any list shorter than 9 messages has its ceiling
 *     clamped to 0 and is fully protected. Ceiling tests therefore use
 *     `NO_CLAMP`, and the clamp has its own tests. An earlier draft of this
 *     file used `NO_CONFIG` for both and every ceiling assertion failed for
 *     reasons that had nothing to do with the ceiling.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeLiveZone, computeToolPairs } from '../../../src/main/proxy/services/liveZone.ts'
import type { ChatMessage } from '../../../src/main/proxy/types.ts'

/** Production default: no explicit floor, `recentMessages` at its default 8. */
const NO_CONFIG = { frozenPrefixMessages: 0, recentMessages: 8 } as const

/** The live-zone ceiling with the count-based clamp switched off. */
const NO_CLAMP = { frozenPrefixMessages: 0, recentMessages: 0 } as const

function msg(role: string, extra: Record<string, unknown> = {}): ChatMessage {
  return { role, content: role, ...extra } as ChatMessage
}

function toolResult(id: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: 'result ' + id } as ChatMessage
}

function assistantWithCalls(ids: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'exec', arguments: '{}' } })),
  } as ChatMessage
}

/** Three completed tool turns plus a trailing user turn. Length 10. */
const THREE_TOOL_TURNS: ChatMessage[] = [
  msg('user'),
  assistantWithCalls(['c0']),
  toolResult('c0'),
  msg('user'),
  assistantWithCalls(['c1']),
  toolResult('c1'),
  msg('user'),
  assistantWithCalls(['c2']),
  toolResult('c2'),
  msg('user'),
]

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

test('with no cache_control and no frozen prefix the floor is zero and the source is recent-window', () => {
  const zone = computeLiveZone([msg('user'), msg('assistant'), msg('user')], NO_CONFIG)
  assert.equal(zone.floor, 0)
  assert.equal(zone.source, 'recent-window')
})

test('frozenPrefixMessages sets the floor and reports its own source', () => {
  const messages = [msg('user'), msg('assistant'), msg('user'), msg('assistant'), msg('user')]
  const zone = computeLiveZone(messages, { frozenPrefixMessages: 2, recentMessages: 8 })
  assert.equal(zone.floor, 2)
  assert.equal(zone.source, 'frozen-prefix')
})

test('cache_control on an assistant message puts the floor one past the last breakpoint', () => {
  const messages = [
    msg('system'),
    msg('user'),
    msg('assistant', { cache_control: { type: 'ephemeral' } }),
    msg('user'),
    msg('assistant', { cache_control: { type: 'ephemeral' } }),
    msg('user'),
    msg('assistant', { cache_control: { type: 'ephemeral' } }),
    msg('user'),
  ] as ChatMessage[]

  const zone = computeLiveZone(messages, NO_CONFIG)
  // `cache_control` marks a message as PART of the cacheable prefix, so the
  // first mutable index is one past the last breakpoint. Breakpoints sit at
  // 2, 4 and 6, so the floor is 7.
  assert.equal(zone.floor, 7)
  assert.equal(zone.source, 'cache-control')
  assert.equal(zone.ceiling, 7, 'only the active user turn is left above the floor')
})

test('an explicit frozen prefix outranks a cache_control breakpoint when it is stricter', () => {
  // A stricter floor is always safe: freezing more only preserves more cache.
  const messages = [
    msg('user'),
    msg('assistant', { cache_control: { type: 'ephemeral' } }),
    msg('user'),
    msg('assistant', { cache_control: { type: 'ephemeral' } }),
    msg('user'),
  ] as ChatMessage[]

  const zone = computeLiveZone(messages, { frozenPrefixMessages: 4, recentMessages: 8 })
  assert.equal(zone.floor, 4)
  assert.equal(zone.source, 'frozen-prefix')
})

test('a cache_control breakpoint on a non-assistant message is ignored', () => {
  // A breakpoint on a user message describes a suffix boundary, not the start of
  // a cacheable prefix. Honoring it would freeze the active turn out of the live
  // zone entirely.
  const messages = [
    msg('user'),
    msg('assistant', { cache_control: 'ephemeral' }),
    msg('user', { cache_control: { type: 'ephemeral' } }),
    msg('assistant'),
  ] as ChatMessage[]
  assert.equal(computeLiveZone(messages, NO_CONFIG).source, 'recent-window')
})

test('the floor never exceeds the message count', () => {
  const zone = computeLiveZone([msg('user'), msg('assistant')], { frozenPrefixMessages: 99, recentMessages: 8 })
  assert.equal(zone.floor, 2)
})

// ---------------------------------------------------------------------------
// Ceiling, with the count clamp off
// ---------------------------------------------------------------------------

test('the ceiling is the later of the latest user and latest tool message', () => {
  const zone = computeLiveZone(THREE_TOOL_TURNS, NO_CLAMP)
  assert.equal(zone.ceiling, 9, 'the trailing user message is the ceiling')
})

test('a trailing assistant message is never a compression candidate', () => {
  const messages = [
    msg('user'),
    assistantWithCalls(['c1']),
    toolResult('c1'),
    msg('assistant', { content: 'thinking out loud' }),
  ]
  const zone = computeLiveZone(messages, NO_CLAMP)

  // The ceiling follows the user/tool rule, so it stays at the latest tool
  // message. The trailing assistant message could not be a candidate either
  // way, because eligibility requires `role === 'tool'`; including it would only
  // misreport the number in the optimizer log.
  assert.equal(zone.ceiling, 2)
  assert.equal(zone.isEligible(messages[3], 3), false, 'an assistant message is never eligible')
  assert.equal(zone.isEligible(messages[2], 2), false, 'the latest tool result is never eligible')
})

test('the ceiling falls back to the last index when there is no user or tool message', () => {
  const zone = computeLiveZone([msg('system'), msg('assistant')], NO_CLAMP)
  assert.equal(zone.ceiling, 1)
})

test('a user message carrying a tool_call_id is not the active turn', () => {
  // Some clients emit a tool result wearing `role: 'user'`. Counting it would
  // put the ceiling past the real active turn.
  const messages = [
    msg('user'),
    { role: 'user', tool_call_id: 'c1', content: 'x' },
    msg('assistant'),
  ] as ChatMessage[]

  const zone = computeLiveZone(messages, NO_CLAMP)
  assert.equal(zone.ceiling, 0, 'the latest REAL user message is index 0')
  assert.equal(zone.isEligible(messages[1], 1), false,
    'a user-role tool result is never rewritten as a tool message')
})

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('the middle tool result is eligible and the latest one is not', () => {
  const zone = computeLiveZone(THREE_TOOL_TURNS, NO_CLAMP)
  assert.equal(zone.isEligible(THREE_TOOL_TURNS[2], 2), true, 'c0 is a completed, paired, non-latest result')
  assert.equal(zone.isEligible(THREE_TOOL_TURNS[5], 5), true, 'c1 likewise')
  assert.equal(zone.isEligible(THREE_TOOL_TURNS[8], 8), false, 'c2 is the latest tool result')
})

test('an orphan tool result and an unanswered call are never eligible', () => {
  const messages = [
    msg('user'),
    assistantWithCalls(['declared_never_answered']),
    toolResult('orphan'),
    msg('user'),
  ]
  const zone = computeLiveZone(messages, NO_CLAMP)
  assert.equal(zone.isEligible(messages[2], 2), false, 'no assistant call declares this id')
})

test('a non-tool message is never eligible', () => {
  const messages = [msg('user'), msg('assistant'), msg('user'), msg('user')]
  const zone = computeLiveZone(messages, NO_CLAMP)
  for (let index = 0; index < messages.length; index += 1) {
    assert.equal(zone.isEligible(messages[index], index), false, `index ${index} is not a tool message`)
  }
})

test('a message below the floor is never eligible even when it would otherwise qualify', () => {
  const unfrozen = computeLiveZone(THREE_TOOL_TURNS, NO_CLAMP)
  assert.equal(unfrozen.isEligible(THREE_TOOL_TURNS[5], 5), true, 'c1 qualifies with no floor')

  const frozen = computeLiveZone(THREE_TOOL_TURNS, { frozenPrefixMessages: 6, recentMessages: 8 })
  assert.equal(frozen.isEligible(THREE_TOOL_TURNS[5], 5), false, 'the frozen prefix excludes it')
  assert.equal(frozen.floor, 6)
})

// ---------------------------------------------------------------------------
// The recentMessages clamp, and Critical Constraint 3
// ---------------------------------------------------------------------------

test('REGRESSION: recentMessages clamps the ceiling when no boundary is declared', () => {
  // The pre-Phase-1 rule was `index < max(0, length - recentMessages)`, whose
  // highest eligible index is `length - recentMessages - 1`.
  for (const recentMessages of [1, 2, 3, 8, 100]) {
    const zone = computeLiveZone(THREE_TOOL_TURNS, { frozenPrefixMessages: 0, recentMessages })
    const oldCeiling = Math.max(0, THREE_TOOL_TURNS.length - recentMessages - 1)
    assert.ok(
      zone.ceiling <= oldCeiling,
      `ceiling ${zone.ceiling} exceeded the old cutoff ${oldCeiling} at recentMessages=${recentMessages}`,
    )
    for (let index = oldCeiling + 1; index < THREE_TOOL_TURNS.length; index += 1) {
      assert.equal(
        zone.isEligible(THREE_TOOL_TURNS[index], index),
        false,
        `index ${index} is above the old cutoff but became eligible at recentMessages=${recentMessages}`,
      )
    }
  }
})

test('the default recentMessages of 8 protects a short request entirely', () => {
  // This is why the corpus harness needs several tool turns before the live
  // zone has anything to do at all.
  const short: ChatMessage[] = [
    msg('user'),
    assistantWithCalls(['a']),
    toolResult('a'),
    msg('user'),
    assistantWithCalls(['b']),
    toolResult('b'),
    msg('user'),
  ]
  const zone = computeLiveZone(short, NO_CONFIG)
  assert.equal(zone.ceiling, 0)
  for (let index = 0; index < short.length; index += 1) {
    assert.equal(zone.isEligible(short[index], index), false, `index ${index} must stay protected`)
  }
})

test('the recentMessages clamp applies only while no boundary is declared', () => {
  // The clamp and the cache boundary are two different inputs, so they need two
  // different lists. An earlier draft reused one list that contained a
  // breakpoint, which meant the "clamped" case was never actually clamped.
  const withoutBreakpoint: ChatMessage[] = [
    msg('user'),
    assistantWithCalls(['a']),
    toolResult('a'),
    msg('user'),
    assistantWithCalls(['b']),
    toolResult('b'),
    msg('user'),
    assistantWithCalls(['c']),
    toolResult('c'),
    msg('user'),
  ]
  const clamped = computeLiveZone(withoutBreakpoint, NO_CONFIG)
  assert.equal(clamped.source, 'recent-window')
  assert.equal(clamped.ceiling, 1, '10 messages with recentMessages=8 clamps the ceiling to 1')
  assert.equal(clamped.isEligible(withoutBreakpoint[5], 5), false,
    'the count clamp keeps a mid-conversation tool result protected')

  // Same shape, but the client now declares where its cache prefix ends. The
  // count clamp is skipped and the surface may extend into the region the client
  // told us is not cached.
  const withBreakpoint: ChatMessage[] = [
    msg('user'),
    assistantWithCalls(['a']),
    toolResult('a'),
    msg('user'),
    assistantWithCalls(['b']),
    toolResult('b'),
    { role: 'assistant', content: 'partial', cache_control: { type: 'ephemeral' } },
    toolResult('c'),
    msg('user'),
  ]
  const declared = computeLiveZone(withBreakpoint, NO_CONFIG)
  assert.equal(declared.source, 'cache-control')
  assert.equal(declared.floor, 7, 'the breakpoint at index 6 puts the floor at 7')
  assert.equal(declared.ceiling, 8, 'the count clamp is skipped once a boundary exists')
})

test('REGRESSION: the live zone never widens the pre-Phase-1 surface', () => {
  // Across every shape and every window, anything the old rule excluded stays
  // excluded. The only intended difference is the latest-tool-result
  // protection, which removes candidates rather than adding them.
  const shapes: ChatMessage[][] = [
    [msg('user'), assistantWithCalls(['a']), toolResult('a'), msg('user')],
    [msg('system'), msg('user'), assistantWithCalls(['a']), toolResult('a'), msg('user')],
    [msg('user'), msg('user'), msg('user'), msg('user')],
    [msg('system'), msg('assistant'), toolResult('orphan'), msg('user')],
    [msg('user'), assistantWithCalls(['a']), toolResult('a'), msg('assistant')],
    THREE_TOOL_TURNS,
  ]

  for (const messages of shapes) {
    for (const recentMessages of [0, 1, 2, 8, 100]) {
      const zone = computeLiveZone(messages, { frozenPrefixMessages: 0, recentMessages })
      const oldCutoff = Math.max(0, messages.length - recentMessages)
      for (let index = 0; index < messages.length; index += 1) {
        if (index >= oldCutoff) {
          assert.equal(
            zone.isEligible(messages[index], index),
            false,
            `live zone widened the surface at index ${index}/${messages.length} `
              + `with recentMessages=${recentMessages}`,
          )
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Pairs and edge cases
// ---------------------------------------------------------------------------

test('the live zone carries the tool pairs for the caller', () => {
  const messages = [
    msg('user'),
    assistantWithCalls(['a', 'b']),
    toolResult('a'),
    toolResult('b'),
    msg('user'),
  ]
  const zone = computeLiveZone(messages, NO_CLAMP)
  assert.equal(zone.pairs.length, 2)
  assert.deepEqual(zone.pairs, computeToolPairs(messages))
})

test('an empty message list produces a well-formed zone that rejects out-of-range indices', () => {
  const zone = computeLiveZone([], NO_CONFIG)
  assert.equal(zone.floor, 0)
  assert.equal(zone.ceiling, 0)
  assert.deepEqual(zone.pairs, [])
  assert.equal(zone.isEligible(toolResult('c1'), 0), false, 'index 0 does not exist in an empty list')
})

test('isEligible rejects indices outside the list it was computed for', () => {
  const messages = [msg('user'), assistantWithCalls(['c1']), toolResult('c1'), msg('user')]
  const zone = computeLiveZone(messages, NO_CLAMP)
  assert.equal(zone.isEligible(toolResult('c1'), -1), false)
  assert.equal(zone.isEligible(toolResult('c1'), messages.length), false)
  assert.equal(zone.isEligible(toolResult('c1'), 999), false)
})
