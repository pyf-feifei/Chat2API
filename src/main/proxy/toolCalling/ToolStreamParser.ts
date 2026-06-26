import type { ToolCallingPlan } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0
  private sawToolProtocolMarker = false
  private readonly emittedToolCallFingerprints = new Set<string>()

  constructor(plan: ToolCallingPlan) {
    this.plan = plan
  }

  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (!content || !this.plan.shouldParseResponse) return []

    this.buffer += content
    const chunks: any[] = []

    if (!this.isBufferingToolCall) {
      const markerStart = findMarkerStart(this.buffer, this.plan)
      if (markerStart.matched) {
        this.sawToolProtocolMarker = true
        if (markerStart.index > 0) {
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, markerStart.index), includeRole))
        }
        this.buffer = this.buffer.slice(markerStart.index)
        this.isBufferingToolCall = true
      } else if (markerStart.partial) {
        this.sawToolProtocolMarker = true
        if (markerStart.index > 0) {
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, markerStart.index), includeRole))
          this.buffer = this.buffer.slice(markerStart.index)
        }
        this.isBufferingToolCall = true
        return chunks
      } else {
        chunks.push(createContentChunk(baseChunk, this.buffer, includeRole))
        this.buffer = ''
        return chunks
      }
    }

    const parsed = parseBufferedToolCall(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      for (const toolCall of parsed.toolCalls) {
        if (this.hasSeenToolCall(toolCall)) continue

        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        chunks.push(createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall))
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
    if (!this.buffer) return []

    const parsed = parseBufferedToolCall(this.buffer, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length > 0) {
      const chunks = parsed.toolCalls.flatMap((toolCall) => {
        if (this.hasSeenToolCall(toolCall)) return []

        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        return [createToolCallChunk(baseChunk, indexedToolCall, false)]
      })
      this.buffer = ''
      this.isBufferingToolCall = false
      return chunks
    }

    if (this.isBufferingToolCall || parsed.rawMatches.length > 0 || parsed.invalidToolNames.length > 0) {
      this.buffer = ''
      this.isBufferingToolCall = false
      return []
    }

    const shouldReleaseText = !this.emittedToolCall
    const text = this.buffer
    this.buffer = ''
    this.isBufferingToolCall = false
    return shouldReleaseText ? [createContentChunk(baseChunk, text, false)] : []
  }

  recoverFromContent(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (!content || this.emittedToolCall || !this.plan.shouldParseResponse) return []

    const parsed = parseBufferedToolCall(content, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length === 0) return []

    const chunks = parsed.toolCalls.flatMap((toolCall, index) => {
      if (this.hasSeenToolCall(toolCall)) return []

      const indexedToolCall = {
        ...toolCall,
        index: this.nextToolCallIndex,
        id: toolCall.id || `call_${this.nextToolCallIndex}`,
      }
      this.nextToolCallIndex += 1
      return [createToolCallChunk(baseChunk, indexedToolCall, includeRole && index === 0)]
    })

    if (chunks.length > 0) {
      this.emittedToolCall = true
    }
    this.isBufferingToolCall = false
    this.buffer = ''
    return chunks
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall
  }

  hasPendingToolProtocol(): boolean {
    return this.sawToolProtocolMarker || this.isBufferingToolCall || hasProtocolMarker(this.buffer, this.plan)
  }

  private hasSeenToolCall(toolCall: any): boolean {
    const fingerprint = toolCallFingerprint(toolCall)
    if (this.emittedToolCallFingerprints.has(fingerprint)) {
      return true
    }

    this.emittedToolCallFingerprints.add(fingerprint)
    return false
  }
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

function findMarkerStart(buffer: string, plan: ToolCallingPlan): { matched: boolean; partial: boolean; index: number } {
  const protocol = getToolProtocol(plan.protocol)
  const ranges = fencedRanges(buffer)
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
  if (plan.protocol !== 'managed_xml') return false
  return true
}

function fencedRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = /```[\s\S]*?```/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
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

function toolCallFingerprint(toolCall: any): string {
  const name = typeof toolCall?.function?.name === 'string' ? toolCall.function.name : ''
  const args = typeof toolCall?.function?.arguments === 'string' ? toolCall.function.arguments : ''
  return `${name}\n${canonicalArguments(args)}`
}

function canonicalArguments(args: string): string {
  const trimmed = args.trim()
  if (!trimmed) return '{}'

  try {
    return JSON.stringify(sortJsonValue(JSON.parse(trimmed)))
  } catch {
    return trimmed
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    )
  }

  return value
}
