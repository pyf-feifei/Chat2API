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
  /**
   * A corrective turn for this exact loop was already injected into the
   * conversation and the loop still continued. The route escalates to a
   * terminal error only then; the first detection gets the correction instead.
   */
  correctionAlreadyIssued: boolean
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
// Tool names are client-defined. Never classify a tool as harmless based on
// a built-in client vocabulary; deployments may opt into explicit exclusions.
const DEFAULT_IGNORED_TOOLS: string[] = []

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
      // The corrective turn is itself a user message; it must not reset loop
      // tracking, or a persisted correction would make the same loop look
      // fresh on the next request.
      if (isCorrectionMessage(message)) continue
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
    correctionAlreadyIssued: correctionWasIssuedFor(messages, latest.fingerprint),
  }
}

/**
 * Stable transport tag for the corrective turn the route injects after a
 * first loop detection. It carries the loop fingerprint so a later pass can
 * tell "this loop was already corrected once" from the history alone. The tag
 * is protocol text, never client vocabulary.
 */
export const RESPONSES_TOOL_LOOP_CORRECTION_TAG = '[chat2api_tool_loop_correction'
export function responsesToolLoopCorrectionMessage(
  detection: Pick<ResponsesToolLoopDetection, 'toolName' | 'repeatCount' | 'fingerprint'>,
): string {
  return [
    `${RESPONSES_TOOL_LOOP_CORRECTION_TAG} ${detection.fingerprint}]`,
    `The tool call ${detection.toolName} has now returned the identical unchanged result ${detection.repeatCount} times in a row — repeating it again produces no new information.`,
    'Do not emit that same call again. Instead, either invoke a DIFFERENT declared tool that makes real progress on the user request, or, if the request is actually finished, return the final answer now (ending with the required completion marker where the workflow contract demands it).',
  ].join(' ')
}

function correctionWasIssuedFor(
  messages: readonly ChatMessage[],
  fingerprint: string,
): boolean {
  const needle = `${RESPONSES_TOOL_LOOP_CORRECTION_TAG} ${fingerprint.slice(0, 16)}]`
  return messages.some((message) => {
    if (message.role !== 'user' && message.role !== 'system') return false
    if (typeof message.content === 'string') return message.content.includes(needle)
    if (!Array.isArray(message.content)) return false
    return message.content.some(part => (
      part?.type === 'text' && typeof part.text === 'string' && part.text.includes(needle)
    ))
  })
}

function isCorrectionMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  if (typeof message.content === 'string') return message.content.includes(RESPONSES_TOOL_LOOP_CORRECTION_TAG)
  if (!Array.isArray(message.content)) return false
  return message.content.some(part => (
    part?.type === 'text' && typeof part.text === 'string' && part.text.includes(RESPONSES_TOOL_LOOP_CORRECTION_TAG)
  ))
}
