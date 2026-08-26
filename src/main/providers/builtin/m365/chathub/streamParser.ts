/**
 * M365 ChatHub Stream Parser
 *
 * ChatHub sends SignalR frames separated by \x1e (Record Separator). Each
 * frame is a JSON object; "update"-target messages carry Copilot messages.
 */

export const RECORD_SEPARATOR = '\x1e'

export interface ParsedFrames {
  frames: unknown[]
  remainder: string
}

export function parseFrames(buffer: string): ParsedFrames {
  const parts = buffer.split(RECORD_SEPARATOR)
  const remainder = parts.pop() || ''
  const frames: unknown[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) {
      continue
    }
    try {
      frames.push(JSON.parse(trimmed))
    } catch {
      // ignore malformed frames
    }
  }
  return { frames, remainder }
}

const NAME_KEYS = ['name', 'toolName', 'pluginName', 'functionName']
const ARGS_KEYS = ['arguments', 'args', 'parameters', 'input', 'functionArguments']

interface ToolInfo {
  name: string
  args: unknown
}

function extractToolFields(message: Record<string, unknown>): ToolInfo | null {
  let name = ''
  for (const key of NAME_KEYS) {
    const value = message[key]
    if (typeof value === 'string' && value) {
      name = value
      break
    }
  }
  if (!name) {
    return null
  }
  for (const key of ARGS_KEYS) {
    const value = message[key]
    if (value !== undefined && value !== null) {
      return { name, args: value }
    }
  }
  return null
}

type MessageRecord = Record<string, unknown>

export interface ClassifiedEvent {
  kind: 'text' | 'progress' | 'reasoning' | 'tool'
  text: string
  messageType?: string
  contentType?: string
  toolName?: string
  arguments?: unknown
  raw?: unknown
}

export function classifyUpdateMessages(messages: unknown[]): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }
    const message = raw as MessageRecord
    const text = typeof message.text === 'string' ? message.text : ''
    const messageType = typeof message.messageType === 'string' ? message.messageType : ''
    const contentType = typeof message.contentType === 'string' ? message.contentType : ''
    const contentOrigin = typeof message.contentOrigin === 'string' ? message.contentOrigin : ''
    const addToChainOfThought = message.addToChainOfThought === true

    let kind: ClassifiedEvent['kind'] = 'text'
    if (
      messageType === 'Progress' ||
      contentType === 'SearchResults' ||
      contentType === 'Code' ||
      contentType === 'ToolCall'
    ) {
      kind = 'progress'
    }
    if (contentOrigin === 'ChainOfThoughtSummary' || addToChainOfThought) {
      kind = 'reasoning'
    }
    const toolInfo = extractToolFields(message)
    if (toolInfo && toolInfo.name && toolInfo.args) {
      kind = 'tool'
    }
    if (!text && kind === 'text') {
      continue
    }
    events.push({
      kind,
      text,
      messageType,
      contentType,
      toolName: toolInfo?.name,
      arguments: toolInfo?.args,
      raw: message,
    })
  }
  return events
}

export interface ToolEvent {
  kind: 'tool'
  toolName: string
  arguments: unknown
  raw?: unknown
}

export function extractToolEvents(data: unknown, seen: Set<string>): ToolEvent[] {
  const events: ToolEvent[] = []
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
    } else if (typeof value === 'object' && value !== null) {
      const obj = value as MessageRecord
      const toolInfo = extractToolFields(obj)
      if (toolInfo && toolInfo.name && toolInfo.args) {
        const key = `${toolInfo.name}|${JSON.stringify(toolInfo.args)}`
        if (!seen.has(key)) {
          seen.add(key)
          events.push({ kind: 'tool', toolName: toolInfo.name, arguments: toolInfo.args, raw: obj })
        }
      }
      for (const child of Object.values(obj)) {
        walk(child)
      }
    }
  }
  walk(data)
  return events
}
