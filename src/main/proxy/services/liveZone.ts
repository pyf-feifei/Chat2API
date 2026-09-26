/**
 * Live-zone and tool-pair analysis for the upstream token optimizer.
 *
 * The optimizer must never rewrite a message the model is about to act on, and
 * must never rewrite a byte inside the provider's prompt-cache prefix. Two
 * references drove this design:
 *
 *   - `headroom/crates/headroom-core/src/transforms/live_zone.rs:1-70` and
 *     `:1840-1874`. Chat Completions defines the live zone as the LATEST tool
 *     message and the LATEST user message, separately. All earlier tool and
 *     user messages are cache hot zone and are never touched. The floor is the
 *     frozen cacheable prefix, marked by `cache_control` breakpoints.
 *
 *   - `headroom/crates/headroom-core/src/transforms/safety.rs:1-52`. An
 *     `assistant.tool_calls[].id` and its matching `tool.tool_call_id` must be
 *     compressed as one unit, because splitting them desynchronizes replay and
 *     produces upstream 400s.
 *
 * Design: `docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`
 */

import type { ChatMessage } from '../types.ts'

export interface ToolPair {
  assistantIndex: number
  responseIndex: number
}

export type LiveZoneFloorSource = 'cache-control' | 'frozen-prefix' | 'recent-window'

export interface LiveZoneSettings {
  /**
   * Messages below this index are treated as the frozen cacheable prefix and
   * are never rewritten. Zero means "no explicit floor".
   */
  frozenPrefixMessages: number
  /**
   * The pre-Phase-1 protection window. Retained as the ceiling fallback and as
   * the floor fallback when nothing else declares a boundary, so that an
   * unconfigured deployment keeps exactly the behavior it has today.
   */
  recentMessages: number
}

export interface LiveZone {
  /** Indices below this are the cacheable prefix. */
  floor: number
  /** Indices at or above this are the newest blocks. */
  ceiling: number
  /** Tool-call pairs whose two halves must be compressed together. */
  pairs: ToolPair[]
  /** Which rule produced the floor, for the optimizer log. */
  source: LiveZoneFloorSource
  /** Whether a message at `index` may be rewritten at all. */
  isEligible(message: ChatMessage, index: number): boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Tool-call ids declared by an assistant message, in both the OpenAI
 * (`tool_calls[].id`) and Anthropic (`content[].type === 'tool_use'`) shapes.
 */
function assistantToolCallIds(message: ChatMessage): string[] {
  const ids: string[] = []

  for (const call of message.tool_calls || []) {
    const id = nonEmptyString(asRecord(call)?.id)
    if (id) ids.push(id)
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const record = asRecord(part)
      if (!record || record.type !== 'tool_use') continue
      const id = nonEmptyString(record.id)
      if (id) ids.push(id)
    }
  }

  return ids
}

/**
 * Tool-result ids answered by a message, in both the OpenAI
 * (`role: 'tool'` with `tool_call_id`) and Anthropic
 * (`content[].type === 'tool_result'` with `tool_use_id`) shapes.
 */
function messageToolResultIds(message: ChatMessage): string[] {
  const ids: string[] = []

  const direct = nonEmptyString(message.tool_call_id)
  if (direct) ids.push(direct)

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const record = asRecord(part)
      if (!record || record.type !== 'tool_result') continue
      const id = nonEmptyString(record.tool_use_id) || nonEmptyString(record.toolUseId)
      if (id) ids.push(id)
    }
  }

  return ids
}

/**
 * Pair every declared tool call with the result that answers it.
 *
 * Clients do replay ids across turns. A pair points at the result that
 * immediately follows its declaring assistant turn, so a replay matches the
 * later occurrence rather than the first.
 */
export function computeToolPairs(messages: ChatMessage[]): ToolPair[] {
  const pairs: ToolPair[] = []
  if (!Array.isArray(messages)) return pairs

  // Pending ids, oldest declaration first, so the earliest unanswered
  // declaration consumes the earliest matching result.
  const pending: Array<{ id: string; assistantIndex: number }> = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue

    for (const id of assistantToolCallIds(message)) {
      pending.push({ id, assistantIndex: index })
    }

    for (const id of messageToolResultIds(message)) {
      const matchIndex = pending.findIndex((entry) => entry.id === id)
      if (matchIndex < 0) continue
      const [matched] = pending.splice(matchIndex, 1)
      pairs.push({ assistantIndex: matched.assistantIndex, responseIndex: index })
    }
  }

  return pairs
}

/**
 * Index of the last `cache_control` breakpoint on an assistant message.
 *
 * Only assistant messages count. A client that stamps a breakpoint onto a user
 * message is describing a suffix boundary, not the start of a cacheable prefix,
 * and honoring it would freeze the active turn out of the live zone entirely.
 */
function lastCacheBreakpoint(messages: ChatMessage[]): number {
  let last = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    if (asRecord(message.cache_control)) last = index
  }
  return last
}

/** Index of the latest `role: 'tool'` message. */
function latestToolIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'tool') return index
  }
  return -1
}

/**
 * Index of the latest real user message.
 *
 * A user message carrying a `tool_call_id` is a tool result wearing a user
 * role, which some clients emit. Counting it would put the ceiling past the
 * active turn.
 */
function latestUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (nonEmptyString(message.tool_call_id)) continue
    return index
  }
  return -1
}

/**
 * Compute the live zone for a request.
 *
 * Floor precedence, strictest first. A stricter floor is always safe: freezing
 * more only ever preserves more cache, it never widens the compression surface.
 *
 *   1. `frozenPrefixMessages`, when greater than the cache-derived floor
 *   2. the last `cache_control` breakpoint
 *   3. zero, reported as `recent-window` because nothing declared a boundary
 *
 * An unconfigured deployment therefore gets floor 0, and `isEligible` reduces
 * to "is a tool message above the ceiling", which is the pre-Phase-1 behavior
 * with `recentMessages` as the ceiling proxy.
 */
export function computeLiveZone(
  messages: ChatMessage[],
  settings: LiveZoneSettings,
): LiveZone {
  const list = Array.isArray(messages) ? messages : []
  const length = list.length

  const configuredFloor = Number.isSafeInteger(settings.frozenPrefixMessages)
    && settings.frozenPrefixMessages > 0
    ? Math.min(settings.frozenPrefixMessages, length)
    : 0
  const cacheFloor = lastCacheBreakpoint(list) + 1

  let floor = 0
  let source: LiveZoneFloorSource = 'recent-window'
  if (configuredFloor > 0 && configuredFloor >= cacheFloor) {
    floor = configuredFloor
    source = 'frozen-prefix'
  } else if (cacheFloor > 0) {
    floor = Math.min(cacheFloor, length)
    source = 'cache-control'
  }

  // The ceiling is the newest block the model will respond against: the latest
  // user message, or the latest tool message, whichever is later. The latest
  // assistant message is part of the cache hot zone and is never a candidate.
  const newest = [latestUserIndex(list), latestToolIndex(list)].filter((index) => index >= 0)
  let ceiling = newest.length > 0 ? Math.max(...newest) : Math.max(0, length - 1)

  // When nothing declared a cache boundary, `recentMessages` still clamps the
  // ceiling. The pre-Phase-1 rule was `index < max(0, length - recentMessages)`,
  // so the highest eligible index was `length - recentMessages - 1`. Keeping that
  // clamp is what makes an unconfigured deployment behave exactly as it did
  // before this change; without it a `safe` deployment would start compressing
  // tool results inside its own recent window.
  //
  // The one intentional behavior change is the latest-tool-result protection
  // below, which is strictly a narrowing.
  if (source === 'recent-window') {
    const recentMessages = Number.isSafeInteger(settings.recentMessages) && settings.recentMessages > 0
      ? settings.recentMessages
      : 0
    if (recentMessages > 0) {
      ceiling = Math.min(ceiling, Math.max(0, length - recentMessages - 1))
    }
  }

  const pairs = computeToolPairs(list)
  const pairedResponseIndices = new Set(pairs.map((pair) => pair.responseIndex))

  return {
    floor,
    ceiling,
    pairs,
    source,
    isEligible(message, index) {
      if (!message || message.role !== 'tool') return false
      // The zone was computed for one specific list. A caller that iterates a
      // different array, or an empty list, must not have out-of-range indices
      // silently treated as inside the zone.
      if (index < 0 || index >= length) return false
      if (index < floor) return false
      if (index > ceiling) return false
      // The newest tool result is the one the model is about to act on. When it
      // is also the latest user message's partner the ceiling already covers it;
      // this covers the trailing-assistant case.
      if (index === latestToolIndex(list)) return false
      if (index === latestUserIndex(list)) return false
      // A tool result with no declared assistant call has no lifecycle anchor.
      if (!pairedResponseIndices.has(index)) {
        const id = nonEmptyString(message.tool_call_id)
        if (id) return false
        // An Anthropic-shaped result inside a user message is resolved by the
        // pair index above; reaching here means it is genuinely unpaired.
        if (Array.isArray(message.content) && messageToolResultIds(message).length > 0) return false
      }
      return true
    },
  }
}
