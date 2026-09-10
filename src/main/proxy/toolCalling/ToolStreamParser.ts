import { randomUUID } from 'node:crypto'
import type { ToolCall } from '../types.ts'
import type { ToolCallDiagnostics, ToolCallingPlan } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import { deduplicateEquivalentToolCalls } from './toolCallDeduplication.ts'
import {
  createManagedToolResultWrapperLeakError,
  ManagedToolResultGuard,
  stripManagedToolResultWrappers,
} from './managedToolResultGuard.ts'
import {
  findStrayManagedWorkflowCompletionMarker,
  isManagedWorkflowCompletionMarkerPath,
  stripStrayManagedWorkflowCompletionMarkers,
  trailingPartialManagedWorkflowCompletionMarkerIndex,
} from './workflowCompletion.ts'
// Layering note: the denial pattern table lives in the standalone progress
// module so the strict-loader test harnesses keep working (it must not gain
// relative imports); importing it here is a leaf dependency with no cycle.
import { findManagedToolDenialClaim } from '../adapters/qwenAiProgressIntent.ts'
import { platformToolDiagnosticPattern } from './promptGuidance.ts'

const RELEASED_PROSE_TAIL_MAX_CHARS = 400

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private readonly callIdPrefix: string
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0
  private sawToolProtocolMarker = false
  private heldCompletionMarkerEnd: number | undefined
  private heldPartialCompletionMarker = false
  private denialHoldActive = false
  // True when the hold was triggered ONLY by the bare platform diagnostic
  // string ("does not exists") with no capability-claim pattern. In that case
  // the prose is only provably hallucinated when tool calls were parsed in
  // the same response (a tool that "does not exist" cannot have been
  // invoked); without tool calls the text may be a legitimate debugging
  // quotation and is released at flush.
  private denialHoldWeakOnly = false
  // Tail of already-released prose, so a denial claim that straddles a push
  // boundary is still caught (the match may begin in previously emitted text).
  private releasedProseTail = ''
  // Complete assistant content seen so far. The completion-marker visibility
  // guards (code fence, quote, indentation) are positional over the full
  // answer, so they must be evaluated against the whole stream, not the
  // post-release buffer that has already lost its surrounding context.
  private seenContent = ''
  private readonly toolResultGuard: ManagedToolResultGuard
  private diagnostics: ToolCallDiagnostics
  private suppressedInput = false
  private rejectedByWrapperLeak = false
  private readonly inputAlreadyGuarded: boolean

  constructor(
    plan: ToolCallingPlan,
    callIdPrefix?: string,
    options: { inputAlreadyGuarded?: boolean } = {},
  ) {
    this.plan = plan
    this.callIdPrefix = callIdPrefix ?? `call_${randomUUID().replace(/-/g, '')}`
    this.diagnostics = { ...plan.diagnostics }
    this.toolResultGuard = new ManagedToolResultGuard(plan.protocol)
    this.inputAlreadyGuarded = options.inputAlreadyGuarded === true
  }

  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    // A response may replay a completed XML block in a later upstream delta.
    // Once a complete block was emitted, all calls for this response are known;
    // keep the first block and avoid executing a replay a second time.
    if (!content || !this.plan.shouldParseResponse || this.emittedToolCall) return []
    if (this.rejectedByWrapperLeak) {
      this.suppressedInput = true
      return []
    }

    const guarded = this.inputAlreadyGuarded
      ? { content, suppressed: false }
      : this.toolResultGuard.push(content)
    if (this.toolResultGuard.hasDetectedWrapperLeak()) {
      this.markWrapperLeakDetected()
      this.clearBuffer()
      this.suppressedInput = true
      return []
    }

    const chunks = this.pushGuardedContent(guarded.content, baseChunk, includeRole)
    this.suppressedInput = guarded.suppressed && chunks.length === 0
    return chunks
  }

  private pushGuardedContent(content: string, baseChunk: any, includeRole: boolean): any[] {
    if (!content) return []

    this.seenContent += content
    this.buffer += content
    const chunks: any[] = []
    // `includeRole` describes the first output delta, not every delta that
    // happens to be produced from one input fragment. Keep it pending until
    // the first content/tool chunk is emitted.
    let rolePending = includeRole && !this.emittedToolCall

    if (!this.isBufferingToolCall) {
      // A tool-denial claim ("the exec_command tool is currently unavailable")
      // is a hallucinated diagnostic, not client prose. It takes precedence
      // over the completion-marker hold when it starts earlier, so the denial
      // narrative (with any dumped code payload) is never released as
      // pre-marker prose. At flush the parsed tool calls are delivered and the
      // held text is dropped inside the same response.
      if (this.holdDenialProse(chunks, baseChunk, rolePending)) {
        return chunks
      }
      // A stray completion marker that starts before any tool-protocol block
      // must be held next: otherwise the tool-marker match would release the
      // pre-block prose verbatim, marker included.
      if (this.holdCompletionMarker(chunks, baseChunk, rolePending)) {
        return chunks
      }
      const markerStart = findMarkerStart(this.buffer, this.plan)
      if (markerStart.matched) {
        this.sawToolProtocolMarker = true
        if (markerStart.index > 0) {
          this.trackReleasedProse(this.buffer.slice(0, markerStart.index))
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, markerStart.index), rolePending))
          rolePending = false
        }
        this.buffer = this.buffer.slice(markerStart.index)
        this.isBufferingToolCall = true
      } else if (markerStart.partial) {
        this.sawToolProtocolMarker = true
        if (markerStart.index > 0) {
          this.trackReleasedProse(this.buffer.slice(0, markerStart.index))
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, markerStart.index), rolePending))
          rolePending = false
          this.buffer = this.buffer.slice(markerStart.index)
        }
        this.isBufferingToolCall = true
        return chunks
      } else {
        this.trackReleasedProse(this.buffer)
        chunks.push(createContentChunk(baseChunk, this.buffer, rolePending))
        this.buffer = ''
        return chunks
      }
    }

    // Hermes parallel calls are adjacent, individually delimited blocks. Wait
    // for stream completion so the first block does not suppress later calls.
    if (this.plan.protocol === 'qwen_hermes' || this.plan.protocol === 'qwen_native') {
      // A completion marker held as a partial prefix may have been completed by
      // this delta; confirm it while the buffer is still accumulating so the
      // flush path knows the held text is protocol output, not prose.
      if (this.heldCompletionMarkerEnd === undefined) {
        const tailStart = this.seenContent.length - this.buffer.length
        const confirmed = findStrayManagedWorkflowCompletionMarker(this.seenContent, tailStart)
        if (confirmed && confirmed.start === tailStart) {
          this.heldCompletionMarkerEnd = confirmed.end - tailStart
          this.heldPartialCompletionMarker = false
          return chunks
        }
        // The hold was a false positive once the text left the marker path.
        // Release it as ordinary prose instead of suppressing the rest of the
        // response — unless a tool-protocol marker is what actually followed.
        if (this.heldPartialCompletionMarker && !isManagedWorkflowCompletionMarkerPath(this.buffer)) {
          const toolMarker = findMarkerStart(this.buffer, this.plan)
          if (toolMarker.matched || toolMarker.partial) {
            this.sawToolProtocolMarker = true
            this.heldPartialCompletionMarker = false
            if (toolMarker.index > 0) {
              chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, toolMarker.index), rolePending))
              this.buffer = this.buffer.slice(toolMarker.index)
            }
            return chunks
          }
          chunks.push(createContentChunk(baseChunk, this.buffer, rolePending))
          this.clearBuffer()
          return chunks
        }
      }
      return chunks
    }

    const parsed = parseFirstValidToolBlock(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      for (const toolCall of uniqueResponseToolCalls(parsed.toolCalls)) {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
        }
        this.nextToolCallIndex += 1
        chunks.push(createToolCallChunk(baseChunk, indexedToolCall, rolePending))
        rolePending = false
      }
      if (chunks.length > 0) {
        this.emittedToolCall = true
      }
      this.isBufferingToolCall = false
      this.buffer = ''
      return chunks
    }

    if (parsed.invalidToolNames.length > 0) {
      this.isBufferingToolCall = false
      this.buffer = ''
    } else if (parsed.rawMatches.length > 0 && !mayBecomeValidToolCall(this.buffer, this.plan)) {
      this.isBufferingToolCall = false
      this.buffer = ''
    }

    return chunks
  }

  flush(baseChunk: any): any[] {
    if (this.rejectedByWrapperLeak) return []

    const guarded = this.inputAlreadyGuarded
      ? { content: '', suppressed: false }
      : this.toolResultGuard.flush()
    if (this.toolResultGuard.hasDetectedWrapperLeak()) {
      this.markWrapperLeakDetected()
      this.clearBuffer()
      this.suppressedInput = false
      return []
    }

    const chunks = this.pushGuardedContent(guarded.content, baseChunk, false)
    this.suppressedInput = false
    return [...chunks, ...this.flushBufferedToolCall(baseChunk)]
  }

  /**
   * The managed workflow completion marker is protocol output, never client
   * prose. Once a stray marker is held, the model has violated the turn
   * contract in one of two recoverable ways, and both resolve inside this
   * response without a continuation round-trip:
   * - marker + tool-call block: deliver the tool call (the work already
   *   emitted is valid) and drop the marker text;
   * - marker + prose or marker alone: drop the marker; end-of-stream
   *   classification (proof vs dangling stall) runs on the raw accumulated
   *   content and is unaffected by what the parser released.
   */
  private flushHeldCompletionMarker(baseChunk: any, markerEnd: number): any[] {
    const remainder = this.buffer.slice(markerEnd)
    this.clearBuffer()
    const parsed = parseFirstValidToolBlock(remainder, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length === 0) return []

    const chunks = uniqueResponseToolCalls(parsed.toolCalls).flatMap((toolCall) => {
      const indexedToolCall = {
        ...toolCall,
        index: this.nextToolCallIndex,
        id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
      }
      this.nextToolCallIndex += 1
      this.emittedToolCall = true
      return [createToolCallChunk(baseChunk, indexedToolCall, false)]
    })
    return chunks
  }

  private flushBufferedToolCall(baseChunk: any): any[] {
    if (!this.buffer) return []

    // A confirmed hold always starts at buffer index 0 (the buffer is sliced
    // to the hold point and only grows by appends), and its visibility guards
    // were validated against the full stream at hold time.
    if (this.heldCompletionMarkerEnd !== undefined) {
      // A weak-only denial hold that ended up proof-shaped (marker, no tool
      // calls) preserves the prose: the bare diagnostic quotation is not
      // provably hallucinated without an invoked tool, and the proof marker
      // is stripped in place instead of discarding the answer.
      if (this.denialHoldWeakOnly && !this.emittedToolCall) {
        const remainder = this.buffer.slice(this.heldCompletionMarkerEnd)
        const proofParse = parseFirstValidToolBlock(remainder, this.plan, { allowPartial: true })
        if (proofParse.toolCalls.length === 0) {
          const text = stripStrayManagedWorkflowCompletionMarkers(this.buffer)
          this.clearBuffer()
          return [createContentChunk(baseChunk, text, false)]
        }
      }
      return this.flushHeldCompletionMarker(baseChunk, this.heldCompletionMarkerEnd)
    }

    const parsed = parseFirstValidToolBlock(this.buffer, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length > 0) {
      const chunks = uniqueResponseToolCalls(parsed.toolCalls).flatMap((toolCall) => {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        return [createToolCallChunk(baseChunk, indexedToolCall, false)]
      })
      this.clearBuffer()
      return chunks
    }

    if (this.isBufferingToolCall || parsed.rawMatches.length > 0 || parsed.invalidToolNames.length > 0) {
      // A partial completion-marker hold that never completed is ordinary
      // prose, not protocol text: release it instead of dropping it.
      if (
        this.heldPartialCompletionMarker
        && this.heldCompletionMarkerEnd === undefined
        && parsed.rawMatches.length === 0
        && parsed.invalidToolNames.length === 0
      ) {
        const text = this.buffer
        this.clearBuffer()
        return this.emittedToolCall ? [] : [createContentChunk(baseChunk, text, false)]
      }
      // A weak-only denial hold (bare platform diagnostic quotation, no
      // capability-claim pattern) without a parsed tool call is not provably
      // hallucinated — the model may legitimately quote an upstream error
      // while debugging. Release it with any stray markers stripped; with a
      // parsed tool call the claim is definitionally false and stays dropped.
      if (
        this.denialHoldWeakOnly
        && this.heldCompletionMarkerEnd === undefined
        && parsed.rawMatches.length === 0
        && parsed.invalidToolNames.length === 0
      ) {
        const text = stripStrayManagedWorkflowCompletionMarkers(this.buffer)
        this.clearBuffer()
        return this.emittedToolCall ? [] : [createContentChunk(baseChunk, text, false)]
      }
      this.clearBuffer()
      return []
    }

    const shouldReleaseText = !this.emittedToolCall
    const text = this.buffer
    this.clearBuffer()
    return shouldReleaseText ? [createContentChunk(baseChunk, text, false)] : []
  }

  /**
   * Holds a stray managed-workflow completion marker (or its unambiguous
   * partial prefix) out of the visible stream. The pre-marker prose is
   * released immediately; the marker itself accumulates in the buffer until
   * flush decides between a tool call (deliver it, drop the marker) and a
   * terminal proof / dangling stall (drop the marker either way).
   */
  /**
   * Whether stray completion-marker hold-back is active for this plan. The
   * marker is a managed-protocol token regardless of which protocol the plan
   * teaches (qwen_hermes/qwen_native require it; managed_xml/m365_fenced and
   * the other managed protocols never emit it legitimately), so the hold is
   * protocol-agnostic over every response-parsing managed plan. Literal
   * occurrences in code fences/quotes/indentation are preserved by the
   * stray-marker guards.
   */
  private completionMarkerHoldEnabled(): boolean {
    return Boolean(
      this.plan.shouldParseResponse
      && this.plan.allowedToolNames.size > 0,
    )
  }

  private holdCompletionMarker(chunks: any[], baseChunk: any, rolePending: boolean): boolean {
    if (!this.completionMarkerHoldEnabled()) return false

    const tailStart = this.seenContent.length - this.buffer.length
    const toolMarker = findMarkerStart(this.buffer, this.plan)
    const toolMarkerIndex = toolMarker.matched || toolMarker.partial
      ? toolMarker.index
      : Number.POSITIVE_INFINITY

    const stray = findStrayManagedWorkflowCompletionMarker(this.seenContent, tailStart)
    const strayIndex = stray && stray.start >= tailStart ? stray.start - tailStart : Number.POSITIVE_INFINITY
    if (strayIndex < toolMarkerIndex) {
      if (strayIndex > 0) {
        this.trackReleasedProse(this.buffer.slice(0, strayIndex))
        chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, strayIndex), rolePending))
      }
      this.heldCompletionMarkerEnd = stray.end - stray.start
      this.heldPartialCompletionMarker = false
      this.buffer = this.buffer.slice(strayIndex)
      this.isBufferingToolCall = true
      return true
    }

    const partialIndexFull = trailingPartialManagedWorkflowCompletionMarkerIndex(this.seenContent)
    if (partialIndexFull !== undefined) {
      const partialIndex = partialIndexFull - tailStart
      if (partialIndex >= 0 && partialIndex < toolMarkerIndex) {
        if (partialIndex > 0) {
          this.trackReleasedProse(this.buffer.slice(0, partialIndex))
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, partialIndex), rolePending))
          this.buffer = this.buffer.slice(partialIndex)
        }
        this.heldPartialCompletionMarker = true
        this.isBufferingToolCall = true
        return true
      }
    }
    return false
  }

  /**
   * Whether denial-prose hold-back is active for this plan: any managed
   * protocol that parses responses with declared tools. A failed tool result
   * keeps the deliberately relaxed contract (the model may explain the
   * failure), so the hold is disabled there.
   */
  private denialHoldEnabled(): boolean {
    return Boolean(
      this.plan.shouldParseResponse
      && this.plan.allowedToolNames.size > 0
      && this.plan.failedToolResultPending !== true,
    )
  }

  private holdDenialProse(chunks: any[], baseChunk: any, rolePending: boolean): boolean {
    if (!this.denialHoldEnabled() || this.denialHoldActive) return false

    const toolMarker = findMarkerStart(this.buffer, this.plan)
    const toolMarkerIndex = toolMarker.matched || toolMarker.partial
      ? toolMarker.index
      : Number.POSITIVE_INFINITY

    const strongClaim = findManagedToolDenialClaim(this.releasedProseTail + this.buffer)
    const weakClaim = strongClaim
      ? undefined
      : platformToolDiagnosticPattern()?.exec(this.releasedProseTail + this.buffer)
    const claim = strongClaim ?? weakClaim
    if (!claim) return false
    // Hold from the START of the sentence containing the claim: the denial's
    // subject ("the exec_command tool", "Tool exec_command") precedes the
    // matched pattern, and releasing it as pre-hold prose leaves a fragment
    // tail the model then mimics (2026-09-10: every delivered message ended
    // with a "Tool exec_command " fragment).
    const window = this.releasedProseTail + this.buffer
    const claimIndex = strongClaim ? strongClaim.index : weakClaim!.index
    const sentenceStart = sentenceStartBefore(window, claimIndex)
    const bufferIndex = Math.max(0, sentenceStart - this.releasedProseTail.length)
    if (bufferIndex >= toolMarkerIndex) return false

    // A completion marker (or its partial prefix) starting before the denial
    // claim owns the hold instead: everything from the marker onward is
    // protocol text and the pre-marker prose before the claim was already
    // released by the time this check runs in stream order.
    const tailStart = this.seenContent.length - this.buffer.length
    const stray = findStrayManagedWorkflowCompletionMarker(this.seenContent, tailStart)
    const strayIndex = stray && stray.start >= tailStart ? stray.start - tailStart : Number.POSITIVE_INFINITY
    const partialIndexFull = trailingPartialManagedWorkflowCompletionMarkerIndex(this.seenContent)
    const partialIndex = partialIndexFull !== undefined ? partialIndexFull - tailStart : Number.POSITIVE_INFINITY
    const completionIndex = Math.min(strayIndex, partialIndex)
    if (bufferIndex >= completionIndex) return false

    if (bufferIndex > 0) {
      this.trackReleasedProse(this.buffer.slice(0, bufferIndex))
      chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, bufferIndex), rolePending))
      this.buffer = this.buffer.slice(bufferIndex)
    }
    this.denialHoldActive = true
    this.denialHoldWeakOnly = !strongClaim
    this.isBufferingToolCall = true
    return true
  }

  private trackReleasedProse(text: string): void {
    if (!text) return
    this.releasedProseTail = (this.releasedProseTail + text).slice(-RELEASED_PROSE_TAIL_MAX_CHARS)
  }

  private clearBuffer(): void {
    this.buffer = ''
    this.isBufferingToolCall = false
    this.heldCompletionMarkerEnd = undefined
    this.heldPartialCompletionMarker = false
    this.denialHoldWeakOnly = false
  }

  recoverFromContent(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (
      !content
      || this.emittedToolCall
      || this.rejectedByWrapperLeak
      || !this.plan.shouldParseResponse
    ) return []

    const guarded = this.inputAlreadyGuarded
      ? { content, suppressed: false, wrapperLeakDetected: false }
      : stripManagedToolResultWrappers(content, this.plan.protocol)
    if (guarded.wrapperLeakDetected) {
      this.markWrapperLeakDetected()
      return []
    }

    const parsed = parseFirstValidToolBlock(guarded.content, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length === 0) return []

    const chunks = uniqueResponseToolCalls(parsed.toolCalls).flatMap((toolCall, index) => {
      const indexedToolCall = {
        ...toolCall,
        index: this.nextToolCallIndex,
        id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
      }
      this.nextToolCallIndex += 1
      return [createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall && index === 0)]
    })

    if (chunks.length > 0) {
      this.emittedToolCall = true
    }
    this.clearBuffer()
    return chunks
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall
      || (!this.inputAlreadyGuarded && this.toolResultGuard.hasPendingCandidate())
      || this.suppressedInput
      || this.rejectedByWrapperLeak
  }

  hasPendingToolProtocol(): boolean {
    return this.rejectedByWrapperLeak
      || this.sawToolProtocolMarker
      || this.isBufferingToolCall
      || hasProtocolMarker(this.buffer, this.plan)
  }

  inspectForWrapperLeak(content: string): boolean {
    if (!content || this.rejectedByWrapperLeak) return this.rejectedByWrapperLeak
    const guarded = stripManagedToolResultWrappers(content, this.plan.protocol)
    if (guarded.wrapperLeakDetected) this.markWrapperLeakDetected()
    return this.rejectedByWrapperLeak
  }

  hasDetectedWrapperLeak(): boolean {
    return this.rejectedByWrapperLeak
  }

  getProtocolError(): Error | undefined {
    return this.rejectedByWrapperLeak
      ? createManagedToolResultWrapperLeakError()
      : undefined
  }

  getDiagnostics(): ToolCallDiagnostics {
    return { ...this.diagnostics }
  }

  private scopedToolCallId(parsedId: string | undefined, index: number): string {
    void parsedId
    return `${this.callIdPrefix}_${index}`
  }

  private markWrapperLeakDetected(): void {
    if (this.rejectedByWrapperLeak) return
    this.rejectedByWrapperLeak = true
    this.diagnostics = {
      ...this.diagnostics,
      wrapperLeakDetected: true,
    }
    console.warn('[ToolCalling] Blocked leaked managed tool-result wrapper', JSON.stringify({
      wrapperLeakDetected: true,
      requestId: this.diagnostics.requestId,
      providerId: this.diagnostics.providerId,
      model: this.diagnostics.actualModel || this.diagnostics.model,
      protocol: this.plan.protocol,
    }))
  }
}

/**
 * Start index of the sentence containing `index`: the first character after
 * the last sentence terminator before it, bounded so the back-scan never
 * reaches further than 200 characters (a run-on dump without terminators
 * must not drag the hold point into unrelated analysis paragraphs).
 */
function sentenceStartBefore(text: string, index: number): number {
  const floor = Math.max(0, index - 200)
  for (let cursor = index - 1; cursor >= floor; cursor -= 1) {
    const char = text[cursor]
    if (char === '.' || char === '!' || char === '?' || char === '\n'
      || char === '。' || char === '！' || char === '？') {
      return cursor + 1
    }
  }
  return floor
}

function uniqueResponseToolCalls<T extends ToolCall>(toolCalls: readonly T[]): T[] {  const result = deduplicateEquivalentToolCalls(toolCalls)
  if (result.duplicateCount > 0) {
    console.warn(`[ToolCalling] Suppressed ${result.duplicateCount} duplicate tool call(s) in one response`)
  }
  return result.toolCalls
}

function parseBufferedToolCall(
  buffer: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(buffer, {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: options.allowPartial,
  })
}

/**
 * A provider can concatenate a retransmitted, complete tool block into one
 * streamed delta. Parse the first block that contains a valid call and leave
 * all calls inside that block intact, so legitimate parallel invocations are
 * not mistaken for replays.
 */
function parseFirstValidToolBlock(
  content: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const parsed = parseBufferedToolCall(content, plan, options)
  if (plan.protocol === 'qwen_hermes' || plan.protocol === 'qwen_native') {
    return parsed
  }
  if (parsed.toolCalls.length === 0 || parsed.rawMatches.length <= 1) {
    return parsed
  }

  for (const rawMatch of parsed.rawMatches) {
    const candidate = parseBufferedToolCall(rawMatch, plan, options)
    if (candidate.toolCalls.length > 0) {
      return candidate
    }
  }

  return parsed
}

function findMarkerStart(buffer: string, plan: ToolCallingPlan): { matched: boolean; partial: boolean; index: number } {
  const protocol = getToolProtocol(plan.protocol)
  const ranges = plan.protocol === 'm365_fenced' ? [] : fencedRanges(buffer)
  let searchStart = 0
  let partialIndex = -1

  while (searchStart < buffer.length) {
    const detection = protocol.detectStart(buffer.slice(searchStart))
    const markerStart = detection.markerStart
    if (markerStart === undefined) break

    const index = searchStart + markerStart
    if (isInsideRange(index, ranges)) {
      const range = ranges.find((item) => index >= item.start && index < item.end)
      searchStart = range ? range.end : index + 1
      continue
    }

    if (detection.matched) {
      return { matched: true, partial: false, index }
    }

    if (detection.partial) {
      partialIndex = index
    }
    break
  }

  return partialIndex === -1
    ? { matched: false, partial: false, index: -1 }
    : { matched: false, partial: true, index: partialIndex }
}

function hasProtocolMarker(buffer: string, plan: ToolCallingPlan): boolean {
  const detection = findMarkerStart(buffer, plan)
  return detection.matched || detection.partial
}

function mayBecomeValidToolCall(buffer: string, plan: ToolCallingPlan): boolean {
  void buffer
  return plan.protocol === 'managed_xml' || plan.protocol === 'qwen_hermes' || plan.protocol === 'qwen_native' || plan.protocol === 'm365_fenced'
}

function fencedRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let searchIndex = 0
  while (searchIndex < content.length) {
    const start = content.indexOf('```', searchIndex)
    if (start === -1) break
    const closing = content.indexOf('```', start + 3)
    if (closing === -1) {
      ranges.push({ start, end: content.length })
      break
    }
    const end = closing + 3
    ranges.push({ start, end })
    searchIndex = end
  }

  return ranges
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function createContentChunk(baseChunk: any, content: string, includeRole: boolean): any {
  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        content,
      },
      finish_reason: null,
    }],
  }
}

function createToolCallChunk(baseChunk: any, toolCall: any, includeRole: boolean): any {
  const { rawText, ...openAiToolCall } = toolCall
  void rawText

  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        tool_calls: [openAiToolCall],
      },
      finish_reason: null,
    }],
  }
}
