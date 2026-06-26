import type { NormalizedToolDefinition, NormalizedToolResult, ToolParseResult, ToolProtocolId } from '../types.ts'
import type { ToolProtocolDetection } from './base.ts'
import type { ToolCall } from '../../types.ts'

export function detectMarkers(buffer: string, markers: string[]): ToolProtocolDetection {
  let earliest = -1
  for (const marker of markers) {
    const index = buffer.indexOf(marker)
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index
    }
  }

  if (earliest !== -1) {
    return { matched: true, partial: false, markerStart: earliest }
  }

  for (let index = 0; index < buffer.length; index += 1) {
    const suffix = buffer.slice(index)
    if (markers.some((marker) => marker.startsWith(suffix))) {
      return { matched: false, partial: true, markerStart: index }
    }
  }

  return { matched: false, partial: false }
}

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

export function toolNames(tools: NormalizedToolDefinition[]): Set<string> {
  return new Set(tools.map((tool) => tool.name))
}

export function createParseResult(input: {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  invalidToolNames?: string[]
  malformedReason?: string
}): ToolParseResult {
  return {
    content: input.content,
    toolCalls: input.toolCalls,
    protocol: input.protocol,
    rawMatches: input.rawMatches,
    malformedReason: input.malformedReason,
    invalidToolNames: input.invalidToolNames ?? [],
  }
}

export function buildToolCall(
  id: string,
  index: number,
  name: string,
  args: string,
  rawText?: string,
): ToolCall {
  return {
    id,
    index,
    type: 'function',
    function: {
      name,
      arguments: normalizeArguments(args),
    },
    ...(rawText ? { rawText } : {}),
  } as ToolCall
}

export function normalizeArguments(args: unknown): string {
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return '{}'
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
      if (recovered !== undefined) {
        return JSON.stringify(recovered)
      }
      return trimmed
    }
  }

  return JSON.stringify(args ?? {})
}

export function parseJsonValue(value: string): unknown {
  const trimmed = unwrapCdata(value).trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
    if (recovered !== undefined) {
      return recovered
    }
    return decodeXml(trimmed)
  }
}

function recoverJsonValueFromMalformedSnapshots(value: string): unknown | undefined {
  const trimmed = decodeXml(unwrapCdata(value)).trim()
  if (!trimmed || !/^[\[{]/.test(trimmed)) return undefined

  const candidates: Array<{ index: number; value: unknown }> = []
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char !== '{' && char !== '[') continue

    const jsonText = extractBalancedJson(trimmed, index)
    if (!jsonText) continue

    try {
      candidates.push({ index, value: JSON.parse(jsonText) })
    } catch {
      // Keep scanning later positions; repeated snapshots may become valid there.
    }
  }

  if (candidates.length === 0) return undefined
  if (candidates.length > 1) return candidates[candidates.length - 1].value

  const [candidate] = candidates
  if (candidate.index === 0) return undefined

  if (hasRepeatedSnapshotPrefix(trimmed.slice(0, candidate.index), candidate.value)) {
    return candidate.value
  }

  return undefined
}

function extractBalancedJson(value: string, start: number): string | undefined {
  const opener = value[start]
  const closer = opener === '{' ? '}' : ']'
  const stack: string[] = [closer]
  let inString = false
  let escaped = false

  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      stack.push('}')
      continue
    }

    if (char === '[') {
      stack.push(']')
      continue
    }

    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return undefined
      }

      if (stack.length === 0) {
        return value.slice(start, index + 1)
      }
    }
  }

  return undefined
}

function hasRepeatedSnapshotPrefix(prefix: string, value: unknown): boolean {
  if (Array.isArray(value)) {
    return prefix.trimStart().startsWith('[')
  }

  if (!value || typeof value !== 'object') {
    return false
  }

  const keys = Object.keys(value as Record<string, unknown>)
  return keys.some((key) => prefix.includes(JSON.stringify(key)))
}

export function unwrapCdata(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1] : value
}

export function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function addParameter(target: Record<string, unknown>, name: string, value: unknown): void {
  const existing = target[name]
  if (existing === undefined) {
    target[name] = value
  } else if (Array.isArray(existing)) {
    target[name] = [...existing, value]
  } else {
    target[name] = [existing, value]
  }
}

export function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      return `Tool \`${tool.name}\`: ${tool.description || 'No description'}. Arguments JSON schema: ${parameters}`
    })
    .join('\n')
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${result.content}`
}
