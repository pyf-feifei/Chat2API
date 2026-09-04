import type { ToolProtocolId } from './types.ts'

const TOOL_RESULT_START = '<|CHAT2API|tool_result'
const TOOL_RESULT_END = '</|CHAT2API|tool_result>'
// Provider-facing transcripts may expose their tool-result envelope under a
// generic name. Keep these markers in the shared boundary registry rather than
// branching on a client or model name.
const TOOL_RESULT_STARTS = [
  TOOL_RESULT_START,
  '<tool_call_result',
  '<tool_call_results',
  '<function_results',
  '<tool_result',
  '<tool_response>',
] as const
const TOOL_RESULT_ENDS = [
  TOOL_RESULT_END,
  '</tool_call_result>',
  '</tool_call_results>',
  '</function_results>',
  '</tool_result>',
  '</tool_response>',
] as const
// Some clients render a tool result as a function-result envelope and close
// the outer block with this legacy parameter-results tag.
const LEGACY_TOOL_RESULT_ENDS = ['</parameter_results>'] as const
const ALL_TOOL_RESULT_ENDS = [...TOOL_RESULT_ENDS, ...LEGACY_TOOL_RESULT_ENDS] as const
const DISTINCTIVE_PARTIAL_RESULT = '<|CHAT2API|tool_r'
const MARKDOWN_FENCE = '```'

const GENERIC_TOOL_CALL_STARTS = [
  '<tool_call>',
  '<tool_call ',
  '<tool_call_start|>',
  '<function_call>',
  '<function_calls>',
  '<function name=',
  '<|tool_calls>',
  '<tool_calls>',
  '[function_calls]',
  '<antml:function_calls>',
] as const

// These markers are only treated as protocol failures at an output boundary.
// They are deliberately not used by the input-history sanitizer, where the
// same strings may be ordinary documentation or user-provided data.
const UNPROTECTED_TOOL_MARKUP_STARTS = [
  ...GENERIC_TOOL_CALL_STARTS,
  '<tool_call=',
  '<function>',
  '<function ',
  '<function=',
  '<parameter>',
  '<parameter ',
  '<parameter=',
  '<invoke>',
  '<invoke ',
  '<invoke=',
  '</tool_call>',
  '</function>',
  '</parameter>',
  '</invoke>',
] as const

// Qwen Hermes protects a valid call envelope, a line-delimited
// `<function=name>` call, and the platform dialects the model drifts to
// (`<tool_calls>`, `<tool_caller>`, `<function_calls>`). A serialized call
// always opens with one of these malformed opener shapes; closers are left
// to the parser so valid dialect blocks are never shadowed.
const MALFORMED_QWEN_TOOL_MARKUP_STARTS = [
  '<tool_call=',
  '<function>',
  '<function ',
  '<parameter>',
  '<parameter ',
  '<invoke>',
  '<invoke ',
  '<invoke=',
] as const

const UNPROTECTED_TOOL_MARKUP_PREFIXES = [
  ...UNPROTECTED_TOOL_MARKUP_STARTS,
  '<tool_call',
  '<function',
  '<parameter',
  '<invoke',
  '</tool_call',
  '</function',
  '</parameter',
  '</invoke',
] as const

const MALFORMED_QWEN_TOOL_MARKUP_PREFIXES = [
  ...MALFORMED_QWEN_TOOL_MARKUP_STARTS,
  '<tool_call',
  '<function',
  '<parameter',
  '<invoke',
] as const

const PROTECTED_TOOL_CALL_MARKERS: Partial<Record<
  ToolProtocolId,
  { starts: readonly string[]; ends: readonly string[] }
>> = {
  managed_xml: {
    starts: [
      '<|CHAT2API|tool_calls>',
      '<tool_calls>',
      '<|tool_calls>',
      '<\uFF5CQCML\uFF5Ctool_calls>',
    ],
    ends: [
      '</|CHAT2API|tool_calls>',
      '</tool_calls>',
      '</|tool_calls>',
      '</\uFF5CQCML\uFF5Ctool_calls>',
    ],
  },
  managed_bracket: {
    starts: ['[function_calls]'],
    ends: ['[/function_calls]'],
  },
  openai_chat: {
    starts: ['[function_calls]'],
    ends: ['[/function_calls]'],
  },
  qwen_hermes: {
    starts: ['<tool_call>'],
    ends: ['</tool_call>'],
  },
  anthropic_tool_use: {
    starts: ['<antml:function_calls>'],
    ends: ['</antml:function_calls>'],
  },
}

type GuardState = 'text' | 'fenced' | 'tool_call' | 'tool_result'

export interface ManagedToolResultGuardOutput {
  content: string
  suppressed: boolean
}

export interface ManagedToolResultStripResult extends ManagedToolResultGuardOutput {
  wrapperLeakDetected: boolean
}

export type ManagedToolResultWrapperLeakError = Error & {
  status: number
  code: string
  type: string
  param: string
  retryable: boolean
  accountFault: boolean
}

export function createManagedToolResultWrapperLeakError(
  param: string = 'content',
): ManagedToolResultWrapperLeakError {
  const error = new Error(
    'Provider returned an internal managed tool-result wrapper in assistant output',
  ) as ManagedToolResultWrapperLeakError
  error.status = 502
  error.code = 'managed_tool_result_wrapper_leak'
  error.type = 'upstream_protocol_error'
  error.param = param
  error.retryable = false
  error.accountFault = false
  return error
}

/**
 * Removes provider-generated copies of Chat2API tool-result envelopes while
 * preserving the same literal text inside a top-level managed tool call.
 */
export class ManagedToolResultGuard {
  private buffer = ''
  private state: GuardState = 'text'
  private resumeStateAfterToolResult: 'text' | 'fenced' = 'text'
  private activeToolResultEnd = TOOL_RESULT_END
  private wrapperLeakDetected = false
  private readonly toolCallStarts: readonly string[]
  private readonly toolCallEnds: readonly string[]
  private readonly rejectUnprotectedToolCalls: boolean
  private readonly rejectMalformedProtectedToolCalls: boolean
  private readonly bufferUntilFlush: boolean

  constructor(protectedToolCallProtocol: ToolProtocolId | null = 'managed_xml') {
    const markers = protectedToolCallProtocol
      ? PROTECTED_TOOL_CALL_MARKERS[protectedToolCallProtocol]
      : undefined
    this.toolCallStarts = markers?.starts ?? []
    this.toolCallEnds = markers?.ends ?? []
    this.rejectUnprotectedToolCalls = protectedToolCallProtocol === null
    this.rejectMalformedProtectedToolCalls = protectedToolCallProtocol === 'qwen_hermes'
    // Responses-style calls are JSON rather than a delimited text protocol.
    // Hold the candidate until it can be parsed structurally so a literal
    // wrapper inside `arguments` is not mistaken for top-level assistant text.
    this.bufferUntilFlush = protectedToolCallProtocol === 'codex_responses'
  }

  push(content: string): ManagedToolResultGuardOutput {
    if (!content) return { content: '', suppressed: false }
    this.buffer += content
    if (this.bufferUntilFlush) return { content: '', suppressed: false }
    return this.drain(false)
  }

  flush(): ManagedToolResultGuardOutput {
    if (
      this.bufferUntilFlush
      && managedWrapperOccursOnlyInCodexToolArguments(this.buffer)
    ) {
      const content = this.buffer
      this.buffer = ''
      this.state = 'text'
      return { content, suppressed: false }
    }
    return this.drain(true)
  }

  hasDetectedWrapperLeak(): boolean {
    return this.wrapperLeakDetected
  }

  hasPendingCandidate(): boolean {
    return this.state !== 'text' || this.buffer.length > 0
  }

  private drain(final: boolean): ManagedToolResultGuardOutput {
    let content = ''
    let suppressed = false

    if (this.rejectUnprotectedToolCalls) {
      const resultCandidate = findToolResultStart(this.buffer, final)
      if (resultCandidate) {
        this.wrapperLeakDetected = true
        this.buffer = ''
        return { content, suppressed: true }
      }
      const candidate = findEarliestUnprotectedMarkup(this.buffer)
      if (candidate) {
        this.wrapperLeakDetected = true
        this.buffer = ''
        return { content, suppressed: true }
      }
    }

    while (this.buffer) {
      if (this.rejectMalformedProtectedToolCalls && this.state === 'text') {
        const malformed = findEarliestMalformedQwenMarkup(this.buffer, final)
        const protectedStart = findEarliestMarker(this.buffer, this.toolCallStarts)
        if (malformed && (!protectedStart || malformed.index < protectedStart.index)) {
          this.wrapperLeakDetected = true
          this.buffer = ''
          return { content, suppressed: true }
        }
      }

      if (this.state === 'tool_result') {
        suppressed = true
        const endIndex = this.buffer.indexOf(this.activeToolResultEnd)
        if (endIndex !== -1) {
          this.buffer = this.buffer.slice(endIndex + this.activeToolResultEnd.length)
          this.state = this.resumeStateAfterToolResult
          continue
        }
        // The provider/client wrapper can close with a legacy generic marker
        // whose name is not paired with the opening marker. Drop through the
        // same protected-result state until any registered closing boundary.
        const genericEnd = findEarliestMarker(this.buffer, ALL_TOOL_RESULT_ENDS)
        if (genericEnd) {
          this.buffer = this.buffer.slice(genericEnd.index + genericEnd.marker.length)
          this.state = this.resumeStateAfterToolResult
          continue
        }

        if (final) {
          this.buffer = ''
          this.state = 'text'
          break
        }

        const retained = longestSuffixPrefixLength(this.buffer, ALL_TOOL_RESULT_ENDS)
        this.buffer = retained > 0 ? this.buffer.slice(-retained) : ''
        break
      }

      if (this.state === 'fenced') {
        const fenceIndex = this.buffer.indexOf(MARKDOWN_FENCE)
        const toolResultIndex = findToolResultStart(this.buffer, final)
        if (toolResultIndex !== undefined && (fenceIndex === -1 || toolResultIndex.index < fenceIndex)) {
          content += this.buffer.slice(0, toolResultIndex.index)
          this.buffer = this.buffer.slice(toolResultIndex.index + toolResultIndex.marker.length)
          this.activeToolResultEnd = toolResultIndex.end
          this.resumeStateAfterToolResult = 'fenced'
          this.state = 'tool_result'
          this.wrapperLeakDetected = true
          suppressed = true
          continue
        }
        if (fenceIndex !== -1) {
          const fenceEnd = fenceIndex + MARKDOWN_FENCE.length
          content += this.buffer.slice(0, fenceEnd)
          this.buffer = this.buffer.slice(fenceEnd)
          this.state = 'text'
          continue
        }

        if (final) {
          const partialResultIndex = findDistinctivePartialResultSuffix(this.buffer)
          if (partialResultIndex !== -1) {
            content += this.buffer.slice(0, partialResultIndex)
            this.wrapperLeakDetected = true
            suppressed = true
          } else {
            content += this.buffer
          }
          this.buffer = ''
          this.state = 'text'
          break
        }

        const retained = longestSuffixPrefixLength(this.buffer, [
          MARKDOWN_FENCE,
          ...TOOL_RESULT_STARTS,
        ])
        const visibleLength = this.buffer.length - retained
        content += this.buffer.slice(0, visibleLength)
        this.buffer = this.buffer.slice(visibleLength)
        break
      }

      if (this.state === 'tool_call') {
        const end = findEarliestMarker(this.buffer, this.toolCallEnds)
        if (end) {
          const endOffset = end.index + end.marker.length
          content += this.buffer.slice(0, endOffset)
          this.buffer = this.buffer.slice(endOffset)
          this.state = 'text'
          continue
        }

        if (final) {
          content += this.buffer
          this.buffer = ''
          this.state = 'text'
          break
        }

        const retained = longestSuffixPrefixLength(this.buffer, this.toolCallEnds)
        const visibleLength = this.buffer.length - retained
        content += this.buffer.slice(0, visibleLength)
        this.buffer = this.buffer.slice(visibleLength)
        break
      }

      const start = findNextTopLevelStart(
        this.buffer,
        final,
        this.toolCallStarts,
      )
      if (start) {
        content += this.buffer.slice(0, start.index)
        this.buffer = this.buffer.slice(start.index + start.marker.length)

        if (start.kind === 'tool_result') {
          this.activeToolResultEnd = start.end ?? TOOL_RESULT_END
          this.resumeStateAfterToolResult = 'text'
          this.state = 'tool_result'
          this.wrapperLeakDetected = true
          suppressed = true
        } else if (start.kind === 'fence') {
          this.state = 'fenced'
          content += start.marker
        } else {
          this.state = 'tool_call'
          content += start.marker
        }
        continue
      }

      if (final) {
        const partialResultIndex = findDistinctivePartialResultSuffix(this.buffer)
        if (partialResultIndex !== -1) {
          content += this.buffer.slice(0, partialResultIndex)
          this.wrapperLeakDetected = true
          suppressed = true
        } else {
          content += this.buffer
        }
        this.buffer = ''
        break
      }

      const retained = longestSuffixPrefixLength(this.buffer, [
        ...this.toolCallStarts,
        ...(this.rejectUnprotectedToolCalls
          ? UNPROTECTED_TOOL_MARKUP_PREFIXES
          : this.rejectMalformedProtectedToolCalls
            ? MALFORMED_QWEN_TOOL_MARKUP_PREFIXES
            : []),
        MARKDOWN_FENCE,
        ...TOOL_RESULT_STARTS,
      ])
      const visibleLength = this.buffer.length - retained
      content += this.buffer.slice(0, visibleLength)
      this.buffer = this.buffer.slice(visibleLength)
      break
    }

    if (final) {
      this.buffer = ''
      this.state = 'text'
      this.resumeStateAfterToolResult = 'text'
    }
    return { content, suppressed }
  }
}

export function stripManagedToolResultWrappers(
  content: string,
  protectedToolCallProtocol: ToolProtocolId | null = 'managed_xml',
): ManagedToolResultStripResult {
  const guard = new ManagedToolResultGuard(protectedToolCallProtocol)
  const streamed = guard.push(content)
  const flushed = guard.flush()
  return {
    content: streamed.content + flushed.content,
    suppressed: streamed.suppressed || flushed.suppressed,
    wrapperLeakDetected: guard.hasDetectedWrapperLeak(),
  }
}

function findNextTopLevelStart(
  content: string,
  final: boolean,
  toolCallStarts: readonly string[],
): { index: number; marker: string; kind: 'fence' | 'tool_call' | 'tool_result'; end?: string } | undefined {
  const toolCall = findEarliestMarker(content, toolCallStarts)
  const toolResult = findToolResultStart(content, final)
  const fenceIndex = content.indexOf(MARKDOWN_FENCE)

  if (
    toolResult
    && (!toolCall || toolResult.index < toolCall.index)
    && (fenceIndex === -1 || toolResult.index < fenceIndex)
  ) {
    return { ...toolResult, kind: 'tool_result' }
  }
  if (fenceIndex !== -1 && (!toolCall || fenceIndex < toolCall.index)) {
    return { index: fenceIndex, marker: MARKDOWN_FENCE, kind: 'fence' }
  }
  if (toolCall && (fenceIndex === -1 || toolCall.index < fenceIndex)) {
    return { ...toolCall, kind: 'tool_call' }
  }
  return undefined
}

function findEarliestUnprotectedMarkup(
  content: string,
): { index: number; marker: string } | undefined {
  return findEarliestMarker(content, UNPROTECTED_TOOL_MARKUP_STARTS)
}

function findEarliestMalformedQwenMarkup(
  content: string,
  final: boolean,
): { index: number; marker: string } | undefined {
  const candidates = MALFORMED_QWEN_TOOL_MARKUP_STARTS.flatMap(marker => {
    const index = content.indexOf(marker)
    if (index === -1) return []
    const after = content[index + marker.length]
    if (!final && after === undefined) return []
    return [{ index, marker }]
  })

  // `<function=name>` is valid Hermes only as a line-delimited bare call.
  // Inline forms are provider markup emitted as assistant prose and must not
  // cross this boundary as visible text.
  let searchIndex = 0
  while (searchIndex < content.length) {
    const index = content.indexOf('<function=', searchIndex)
    if (index === -1) break
    const lineStart = content.lastIndexOf('\n', index - 1) + 1
    const indentation = content.slice(lineStart, index)
    if (!/^ {0,3}$/.test(indentation)) candidates.push({ index, marker: '<function=' })
    searchIndex = index + '<function='.length
  }

  return candidates.sort((a, b) => a.index - b.index)[0]
}

function findToolResultStart(
  content: string,
  final: boolean,
): { index: number; marker: string; end: string } | undefined {
  let selected: { index: number; marker: string; end: string } | undefined
  for (let markerIndex = 0; markerIndex < TOOL_RESULT_STARTS.length; markerIndex += 1) {
    const marker = TOOL_RESULT_STARTS[markerIndex]
    let searchIndex = 0
    while (searchIndex < content.length) {
      const index = content.indexOf(marker, searchIndex)
      if (index === -1) break

      const boundaryIndex = index + marker.length
      if (
        (boundaryIndex === content.length && final)
        || /[\s>]/.test(content[boundaryIndex] ?? '')
      ) {
        if (!selected || index < selected.index) {
          selected = { index, marker, end: TOOL_RESULT_ENDS[markerIndex] }
        }
        break
      }
      searchIndex = boundaryIndex
    }
  }
  return selected
}

function findEarliestMarker(
  content: string,
  markers: readonly string[],
): { index: number; marker: string } | undefined {
  let selected: { index: number; marker: string } | undefined
  for (const marker of markers) {
    const index = content.indexOf(marker)
    if (index === -1) continue
    if (!selected || index < selected.index) selected = { index, marker }
  }
  return selected
}

function longestSuffixPrefixLength(content: string, markers: readonly string[]): number {
  const maximum = Math.min(
    content.length,
    markers.reduce((length, marker) => Math.max(length, marker.length), 0),
  )
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = content.slice(-length)
    if (markers.some((marker) => marker.startsWith(suffix))) return length
  }
  return 0
}

function findDistinctivePartialResultSuffix(content: string): number {
  const candidates = [
    { marker: TOOL_RESULT_START, minimum: DISTINCTIVE_PARTIAL_RESULT.length },
    { marker: TOOL_RESULT_STARTS[1], minimum: '<tool_call_'.length },
  ]
  for (const candidate of candidates) {
    const maximum = Math.min(content.length, candidate.marker.length)
    for (let length = maximum; length >= candidate.minimum; length -= 1) {
      const suffix = content.slice(-length)
      if (candidate.marker.startsWith(suffix)) return content.length - length
    }
  }
  return -1
}

function managedWrapperOccursOnlyInCodexToolArguments(content: string): boolean {
  if (!TOOL_RESULT_STARTS.some(marker => content.includes(marker))) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return false
  }

  let allowedOccurrence = false
  let disallowedOccurrence = false

  const inspect = (value: unknown, insideToolArguments: boolean): void => {
    if (typeof value === 'string') {
      if (!TOOL_RESULT_STARTS.some(marker => value.includes(marker))) return
      if (insideToolArguments) allowedOccurrence = true
      else disallowedOccurrence = true
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, insideToolArguments)
      return
    }
    if (!value || typeof value !== 'object') return

    const record = value as Record<string, unknown>
    const isFunctionCall = record.type === 'function_call'
      || record.type === 'function'
      || isRecord(record.function)
    const isFunctionPayload = typeof record.name === 'string'
      && Object.prototype.hasOwnProperty.call(record, 'arguments')
    for (const [key, item] of Object.entries(record)) {
      if (key.includes(TOOL_RESULT_START)) {
        if (insideToolArguments) allowedOccurrence = true
        else disallowedOccurrence = true
      }
      inspect(
        item,
        insideToolArguments
          || (key === 'arguments' && (isFunctionCall || isFunctionPayload)),
      )
    }
  }

  inspect(parsed, false)
  return allowedOccurrence && !disallowedOccurrence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
