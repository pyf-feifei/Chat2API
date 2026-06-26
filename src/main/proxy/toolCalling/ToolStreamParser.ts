import type { ToolCallingPlan } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0
  private sawToolProtocolMarker = false

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
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        chunks.push(createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall))
      }
      this.emittedToolCall = true
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
      const chunks = parsed.toolCalls.map((toolCall) => {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        return createToolCallChunk(baseChunk, indexedToolCall, false)
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

    const chunks = parsed.toolCalls.map((toolCall, index) => {
      const indexedToolCall = {
        ...toolCall,
        index: this.nextToolCallIndex,
        id: toolCall.id || `call_${this.nextToolCallIndex}`,
      }
      this.nextToolCallIndex += 1
      return createToolCallChunk(baseChunk, indexedToolCall, includeRole && index === 0)
    })

    this.emittedToolCall = true
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
  let partialIndex = -1

  for (let index = 0; index < buffer.length; index += 1) {
    if (isInsideRange(index, ranges)) continue

    const suffix = buffer.slice(index)
    const detection = protocol.detectStart(suffix)
    if (detection.matched && detection.markerStart === 0) {
      return { matched: true, partial: false, index }
    }
    if (detection.partial && detection.markerStart === 0 && partialIndex === -1) {
      partialIndex = index
    }
  }

  return partialIndex === -1
    ? { matched: false, partial: false, index: -1 }
    : { matched: false, partial: true, index: partialIndex }
}

function hasProtocolMarker(buffer: string, plan: ToolCallingPlan): boolean {
  const protocol = getToolProtocol(plan.protocol)
  for (let index = 0; index < buffer.length; index += 1) {
    const detection = protocol.detectStart(buffer.slice(index))
    if (detection.matched || detection.partial) {
      return true
    }
  }
  return false
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
