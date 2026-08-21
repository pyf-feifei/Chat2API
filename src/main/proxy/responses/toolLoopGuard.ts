import { createHash } from 'node:crypto'
import type { ChatMessage, ChatCompletionMessageToolCall } from '../types'

export interface ResponsesToolLoopGuardOptions {
  threshold?: number
  windowSize?: number
  ignoredTools?: Iterable<string>
}

export interface ResponsesToolLoopDetection {
  toolName: string
  repeatCount: number
  fingerprint: string
}

interface PendingToolCall {
  name: string
  fingerprint: string
}

interface CompletedToolCall extends PendingToolCall {
  resultFingerprint: string
}

const DEFAULT_THRESHOLD = 3
const DEFAULT_WINDOW_SIZE = 8
const DEFAULT_IGNORED_TOOLS = ['wait', 'wait_agent', 'write_stdin']

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function ignoredToolsFromEnv(): string[] {
  const raw = process.env.CHAT2API_RESPONSES_TOOL_LOOP_IGNORED_TOOLS
  if (raw === undefined) return DEFAULT_IGNORED_TOOLS
  return raw.split(',').map(value => value.trim()).filter(Boolean)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

function canonicalArguments(value: string): string {
  try {
    return JSON.stringify(canonicalize(JSON.parse(value)))
  } catch {
    return value.trim().replace(/\s+/g, ' ')
  }
}

function stableString(value: unknown): string {
  if (typeof value === 'string') return value.trim().replace(/\r\n/g, '\n')
  return JSON.stringify(canonicalize(value))
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function toolCallFingerprint(toolCall: ChatCompletionMessageToolCall): PendingToolCall {
  const name = toolCall.function.name.trim()
  const argumentsValue = canonicalArguments(toolCall.function.arguments)
  return {
    name,
    fingerprint: hash(`${name}\n${argumentsValue}`),
  }
}

function hasMeaningfulText(message: ChatMessage): boolean {
  if (typeof message.content === 'string') return Boolean(message.content.trim())
  if (!Array.isArray(message.content)) return false
  return message.content.some(part => part.type === 'text' && Boolean(part.text?.trim()))
}

export function detectResponsesToolLoop(
  messages: readonly ChatMessage[],
  options: ResponsesToolLoopGuardOptions = {},
): ResponsesToolLoopDetection | undefined {
  const threshold = options.threshold
    ?? positiveIntegerFromEnv('CHAT2API_RESPONSES_TOOL_LOOP_THRESHOLD', DEFAULT_THRESHOLD)
  const windowSize = Math.max(
    threshold,
    options.windowSize
      ?? positiveIntegerFromEnv('CHAT2API_RESPONSES_TOOL_LOOP_WINDOW', DEFAULT_WINDOW_SIZE),
  )
  const ignoredTools = new Set(
    Array.from(options.ignoredTools ?? ignoredToolsFromEnv(), value => value.trim().toLowerCase()),
  )
  const pending = new Map<string, PendingToolCall>()
  let completed: CompletedToolCall[] = []

  for (const message of messages) {
    if (message.role === 'user' && hasMeaningfulText(message)) {
      pending.clear()
      completed = []
      continue
    }
    if (message.role === 'assistant') {
      if (!message.tool_calls?.length && hasMeaningfulText(message)) {
        pending.clear()
        completed = []
        continue
      }
      for (const toolCall of message.tool_calls ?? []) {
        pending.set(toolCall.id, toolCallFingerprint(toolCall))
      }
      continue
    }
    if (message.role !== 'tool' || !message.tool_call_id) continue
    const call = pending.get(message.tool_call_id)
    if (!call) continue
    pending.delete(message.tool_call_id)
    if (ignoredTools.has(call.name.toLowerCase())) continue
    completed = [
      ...completed,
      {
        ...call,
        resultFingerprint: hash(`${message.is_error === true ? 'error' : 'result'}\n${stableString(message.content)}`),
      },
    ].slice(-windowSize)
  }

  const latest = completed.at(-1)
  if (!latest) return undefined
  const repeatCount = completed.filter(candidate => (
    candidate.fingerprint === latest.fingerprint
    && candidate.resultFingerprint === latest.resultFingerprint
  )).length
  if (repeatCount < threshold) return undefined
  return {
    toolName: latest.name,
    repeatCount,
    fingerprint: latest.fingerprint.slice(0, 16),
  }
}
