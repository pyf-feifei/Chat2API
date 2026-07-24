/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types'
import type { ProviderModelCapability } from '../../../shared/types'
import { hasToolUse, parseToolUse } from '../promptToolUse'
import { QwenAiTokenRefresher } from './qwen-ai-token-refresh'
import {
  QwenAiFileUploader,
  QWEN_AI_DOCUMENT_EVIDENCE_MARKER,
  prepareQwenAiMultimodalMessage,
  type QwenAiDirectUploadInput,
  type QwenAiDirectUploadStartResult,
} from './qwen-ai-files'
import { createBaseChunk } from '../utils/streamToolHandler'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import { normalizeArguments } from '../toolCalling/protocols/shared'
import {
  getToolStreamValidationFailure,
  type ToolStreamValidationFailure,
} from '../toolCalling/streamValidationPolicy'
import type { ToolCall } from '../types'
import {
  isCompleteJsonText,
  mergeNativeToolArguments,
  normalizeNativeFunctionCallDelta,
  type NativeToolCallState,
} from './qwen-ai-native-tools'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const QWEN_AI_REQUEST_TIMEOUT_MS = positiveNumberFromEnv('QWEN_AI_REQUEST_TIMEOUT_MS', 300000)
const QWEN_AI_RESPONSE_TIMEOUT_MS = nonNegativeNumberFromEnv('QWEN_AI_RESPONSE_TIMEOUT_MS', 0)
const QWEN_AI_STREAM_IDLE_TIMEOUT_MS = positiveNumberFromEnv('QWEN_AI_STREAM_IDLE_TIMEOUT_MS', 180000)
const QWEN_AI_DEBUG_PAYLOAD_LOGS = process.env.CHAT2API_QWEN_AI_DEBUG_PAYLOADS === 'true'
const QWEN_AI_DEBUG_STREAM_LOGS = process.env.CHAT2API_QWEN_AI_DEBUG_STREAM === 'true'
const QWEN_AI_DEBUG_REQUEST_LOGS = process.env.CHAT2API_QWEN_AI_DEBUG_REQUEST === 'true'

export const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

export type QwenAiOutputStream = PassThrough & {
  qwenAiFailure?: Error
}

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Version: '0.2.67',
  Origin: 'https://chat.qwen.ai',
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.8': 'qwen3.8-max-preview',
  'qwen3.8-max-preview': 'qwen3.8-max-preview',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3.6-35b': 'qwen3.6-35b-a3b',
  'qwen3.6-27b': 'qwen3.6-27b',
  'qwen3-coder': 'qwen3-coder-plus',
}

type QwenAiMessage = ChatMessage

type StreamHandlingOptions = {
  signal?: AbortSignal
  responseTimeoutMs?: number
  idleTimeoutMs?: number
  onFailure?: (error: Error) => void
  recoverFromIdle?: (error: Error) => Promise<boolean>
}

type QwenAiResumableStreamOptions = {
  signal?: AbortSignal
  getResponseId: () => string
  resume?: (responseId: string) => Promise<any>
  /** Return true once the adapter has emitted a terminal response. */
  isComplete?: () => boolean
  maxAttempts?: number
  delayMs?: number
}

export type QwenAiResumableStream = PassThrough & {
  /** Replace a semantically stalled source with Qwen's response-id continuation. */
  recoverFromIdle: (error: Error) => Promise<boolean>
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  chatId?: string
  signal?: AbortSignal
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

export function qwenAiStreamResumeAttemptsFromEnv(): number {
  return Math.min(
    10,
    nonNegativeIntegerFromEnv('CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS', 3),
  )
}

export function qwenAiStreamResumeDelayMsFromEnv(): number {
  return Math.min(
    60_000,
    nonNegativeIntegerFromEnv('CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS', 1_000),
  )
}

/**
 * Decide whether a parsed SSE message represents provider progress.
 *
 * Qwen can keep an HTTP response open with SSE comments or empty/heartbeat
 * events. Those bytes prove that the socket is alive, but they do not prove
 * that generation is making progress. The idle budget must therefore be
 * refreshed after parsing a meaningful event, rather than for every raw
 * network buffer.
 */
function isMeaningfulQwenAiEvent(
  event: { data?: unknown },
  previousSummaryLength = 0,
): boolean {
  const raw = typeof event.data === 'string' ? event.data.trim() : ''
  if (!raw) return false
  if (raw === '[DONE]') return true

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // A non-JSON event is handled as an upstream error by the parser. Count
    // it as activity so the resulting error is reported immediately.
    return true
  }

  if (!isObjectValue(data)) return false
  if (data.error || data.errors || data.ret) return true
  if (data['response.created']) return false

  const choices = data.choices
  if (!Array.isArray(choices)) return false

  return choices.some((choice) => {
    if (!isObjectValue(choice)) return false
    const delta = isObjectValue(choice.delta) ? choice.delta : undefined
    if (!delta) return typeof choice.finish_reason === 'string' && Boolean(choice.finish_reason)

    const content = delta.content
    const reasoning = delta.reasoning_content
    const summaryText = isObjectValue(delta.extra)
      && isObjectValue(delta.extra.summary_thought)
      && Array.isArray(delta.extra.summary_thought.content)
      ? delta.extra.summary_thought.content
        .filter((part: unknown): part is string => typeof part === 'string')
        .join('\n')
      : ''

    return (typeof content === 'string' && content.length > 0)
      || (typeof reasoning === 'string' && reasoning.length > 0)
      || (delta.phase === 'thinking_summary' && summaryText.length > previousSummaryLength)
      || (delta.status === 'finished' && (delta.phase === 'answer' || delta.phase === null))
      || (typeof choice.finish_reason === 'string' && Boolean(choice.finish_reason))
  })
}

function destroyReadableStream(stream: any, error?: Error): void {
  if (!stream) return

  if (typeof stream.destroy === 'function') {
    stream.destroy(error)
    return
  }

  if (typeof stream.abort === 'function') {
    stream.abort()
  }
}

function isResumableQwenAiTransportError(error: unknown): boolean {
  if (!error || isClientCancellationError(error)) return false

  const candidate = error as {
    status?: unknown
    code?: unknown
    name?: unknown
    message?: unknown
  }
  if (typeof candidate.status === 'number' && candidate.status >= 400) return false

  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  const message = typeof candidate.message === 'string'
    ? candidate.message
    : String(error)

  return /ECONNRESET|ECONNABORTED|ERR_STREAM_PREMATURE_CLOSE|ERR_NETWORK|ERR_SOCKET|socket hang up|premature close|network error/i.test(
    `${name} ${code} ${message}`,
  )
}

/**
 * Keep a Qwen SSE response alive across a transport close. Qwen's web client
 * resumes an in-progress response with the chat and response identifiers;
 * keeping that recovery below the protocol adapter means every compatible
 * downstream client benefits without knowing provider-specific details.
 */
export function createQwenAiResumableStream(
  initialStream: any,
  options: QwenAiResumableStreamOptions,
): QwenAiResumableStream {
  const bridge = new PassThrough() as QwenAiResumableStream
  const maxAttempts = Math.max(0, options.maxAttempts ?? qwenAiStreamResumeAttemptsFromEnv())
  const delayMs = Math.max(0, options.delayMs ?? qwenAiStreamResumeDelayMsFromEnv())

  let source = initialStream
  let sourceGeneration = 0
  let sourceHandled = false
  let sourceComplete = false
  let terminalMarkerSeen = false
  let recoveryInFlight = false
  let attempts = 0
  let settled = false

  type SourceListeners = {
    data: (chunk: Buffer | string) => void
    error: (error: Error) => void
    end: () => void
    close: () => void
  }

  // Keep the exact callbacks installed by this bridge. The response stream
  // may also have listeners owned by Axios or the protocol parser; removing
  // those with removeAllListeners() can break cancellation and parsing.
  const sourceListeners = new Map<any, SourceListeners>()
  let completionScan = ''
  let completionCheckError: Error | undefined

  const removeAbortListener = () => {
    options.signal?.removeEventListener('abort', onAbort)
  }

  const detachSource = (stream: any, destroy = false) => {
    const listeners = sourceListeners.get(stream)
    if (listeners && typeof stream?.removeListener === 'function') {
      stream.removeListener('data', listeners.data)
      stream.removeListener('error', listeners.error)
      stream.removeListener('end', listeners.end)
      stream.removeListener('close', listeners.close)
      sourceListeners.delete(stream)
    }
    if (destroy) destroyReadableStream(stream)
  }

  const fail = (error: Error) => {
    if (settled) return
    settled = true
    detachSource(source, true)
    removeAbortListener()
    bridge.destroy(error)
  }

  const finish = () => {
    if (settled) return
    settled = true
    detachSource(source, true)
    removeAbortListener()
    bridge.end()
  }

  const checkComplete = (): boolean => {
    if (sourceComplete) return true
    if (!options.isComplete) return false
    try {
      if (options.isComplete()) sourceComplete = true
    } catch (error) {
      completionCheckError = error instanceof Error ? error : new Error(String(error))
    }
    return sourceComplete
  }

  const takeCompletionCheckError = (): Error | undefined => {
    const error = completionCheckError
    completionCheckError = undefined
    return error
  }

  const sawDoneMarker = (chunk: Buffer | string): boolean => {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : ''
    if (!text) return false

    // Keep enough tail to recognize a marker split across network chunks,
    // while requiring an SSE data-line boundary to avoid matching model text.
    completionScan = `${completionScan}${text}`.slice(-128)
    return /(?:^|\r?\n)data\s*:\s*\[DONE\](?:\r?\n|$)/.test(completionScan)
  }

  const waitForRetry = async (): Promise<boolean> => {
    if (delayMs <= 0) return !options.signal?.aborted
    if (options.signal?.aborted) return false

    return new Promise<boolean>(resolve => {
      let timer: NodeJS.Timeout | undefined
      let finished = false

      const complete = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onRetryAbort)
        resolve(result && !options.signal?.aborted)
      }

      const onRetryAbort = () => complete(false)
      timer = setTimeout(() => complete(true), delayMs)
      options.signal?.addEventListener('abort', onRetryAbort, { once: true })
    })
  }

  const retireCurrentSource = () => {
    detachSource(source, true)
  }

  const recover = async (initialError?: Error): Promise<boolean> => {
    if (recoveryInFlight || settled) return false
    recoveryInFlight = true
    let lastError = initialError || new Error('Qwen AI response stream closed before completion')

    while (!settled && attempts < maxAttempts) {
      if (checkComplete()) {
        const completionError = takeCompletionCheckError()
        recoveryInFlight = false
        if (completionError) fail(completionError)
        else finish()
        return false
      }
      const completionError = takeCompletionCheckError()
      if (completionError) {
        recoveryInFlight = false
        fail(completionError)
        return false
      }

      if (options.signal?.aborted) {
        recoveryInFlight = false
        fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
        return false
      }

      const responseId = options.getResponseId().trim()
      if (!responseId || !options.resume) break

      attempts += 1
      if (!(await waitForRetry())) {
        recoveryInFlight = false
        fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
        return false
      }
      if (settled) return false

      if (checkComplete()) {
        const lateCompletionError = takeCompletionCheckError()
        recoveryInFlight = false
        if (lateCompletionError) fail(lateCompletionError)
        else finish()
        return false
      }
      const lateCompletionCheckError = takeCompletionCheckError()
      if (lateCompletionCheckError) {
        recoveryInFlight = false
        fail(lateCompletionCheckError)
        return false
      }

      try {
        console.warn('[QwenAI] Resuming interrupted response stream', JSON.stringify({
          responseId,
          attempt: attempts,
          maxAttempts,
        }))
        const resumed = await options.resume(responseId)
        const nextStream = resumed?.data ?? resumed

        // Abort/completion can race the resume request. Never attach a late
        // response to the bridge; release it immediately instead.
        if (settled || options.signal?.aborted || sourceComplete || checkComplete()) {
          destroyReadableStream(nextStream)
          if (!settled) {
            const lateResumeError = takeCompletionCheckError()
            if (lateResumeError) fail(lateResumeError)
            else finish()
          }
          return false
        }

        if (!nextStream || typeof nextStream.on !== 'function') {
          throw new Error('Qwen AI resume endpoint did not return a stream')
        }

        source = nextStream
        sourceGeneration += 1
        sourceHandled = false
        sourceComplete = false
        terminalMarkerSeen = false
        completionScan = ''
        recoveryInFlight = false
        attachSource(nextStream, sourceGeneration)
        return true
      } catch (error) {
        if (settled) return false
        lastError = error instanceof Error ? error : new Error(String(error))
        if (isClientCancellationError(lastError) || options.signal?.aborted) {
          recoveryInFlight = false
          fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
          return false
        }
      }
    }

    if (settled) return false
    recoveryInFlight = false
    if (checkComplete()) {
      const completionError = takeCompletionCheckError()
      if (completionError) fail(completionError)
      else finish()
      return false
    }
    const completionError = takeCompletionCheckError()
    if (completionError) {
      fail(completionError)
      return false
    }
    const transportError = normalizeQwenAiStreamFailure(lastError)
    // A transport reset is not evidence that credentials/account state is bad;
    // avoid cooling a single account when the shared upstream path is failing.
    transportError.accountFault = false
    fail(transportError)
    return false
  }

  bridge.recoverFromIdle = async (error: Error): Promise<boolean> => {
    if (settled || recoveryInFlight) return false

    const complete = checkComplete()
    const completionError = takeCompletionCheckError()
    if (completionError) {
      fail(completionError)
      return false
    }
    if (complete) {
      finish()
      return false
    }

    // Mark and detach synchronously so late bytes from the stalled socket
    // cannot race the continuation stream into the shared parser.
    sourceHandled = true
    retireCurrentSource()
    return recover(error)
  }

  const handleSourceEnd = (generation: number) => {
    if (settled || generation !== sourceGeneration || sourceHandled) return
    sourceHandled = true
    const complete = checkComplete()
    const completionError = takeCompletionCheckError()
    retireCurrentSource()
    if (completionError) {
      fail(completionError)
      return
    }
    if (complete) {
      finish()
      return
    }
    void recover()
  }

  const handleSourceError = (generation: number, error: Error) => {
    if (settled || generation !== sourceGeneration || sourceHandled) return
    sourceHandled = true
    const complete = checkComplete()
    const completionError = takeCompletionCheckError()
    retireCurrentSource()
    if (completionError) {
      fail(completionError)
      return
    }
    if (complete) {
      finish()
      return
    }
    if (options.signal?.aborted || isClientCancellationError(error)) {
      fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
      return
    }
    if (isResumableQwenAiTransportError(error)) {
      void recover(error)
      return
    }
    fail(error)
  }

  function attachSource(nextStream: any, generation: number) {
    const listeners: SourceListeners = {
      data: (chunk: Buffer | string) => {
        if (settled || generation !== sourceGeneration || terminalMarkerSeen) return
        try {
          bridge.write(chunk)
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return
        }

        const done = sawDoneMarker(chunk)
        const complete = checkComplete()
        const completionError = takeCompletionCheckError()
        if (completionError) {
          fail(completionError)
          return
        }
        if (done) {
          sourceComplete = true
          terminalMarkerSeen = true
          // [DONE] is definitive; close the downstream bridge even if the
          // provider forgets to emit its final close event.
          finish()
        } else if (complete) {
          // Defer bridge completion until end/close so a handler can still
          // consume a provider finish event and emit its own terminal frame.
          sourceComplete = true
        }
      },
      error: (error: Error) => handleSourceError(generation, error),
      end: () => handleSourceEnd(generation),
      close: () => {
        if (!sourceHandled) handleSourceEnd(generation)
      },
    }
    sourceListeners.set(nextStream, listeners)
    nextStream.on('data', listeners.data)
    nextStream.once('error', listeners.error)
    nextStream.once('end', listeners.end)
    nextStream.once('close', listeners.close)
  }

  function onAbort() {
    if (settled) return
    fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
  }

  bridge.once('close', () => {
    if (settled) return
    settled = true
    detachSource(source, true)
    removeAbortListener()
  })

  if (options.signal?.aborted) {
    onAbort()
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true })
    sourceGeneration = 1
    attachSource(source, sourceGeneration)
  }

  return bridge
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

function currentTimezoneHeader(): string {
  return new Date().toString().replace(/\s*\(.+\)$/, '')
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function describeErrorForLog(error: unknown): string {
  const record = isObjectValue(error) ? error : undefined
  const response = isObjectValue(record?.response) ? record.response : undefined
  const name = error instanceof Error && error.name ? error.name : 'Error'
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|cookie|authorization|x5secdata|x5sectag)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500)
  const directStatus = typeof record?.status === 'number'
    ? record.status
    : typeof record?.statusCode === 'number'
      ? record.statusCode
      : undefined
  const responseStatus = typeof response?.status === 'number' ? response.status : undefined
  const statusValue = directStatus ?? responseStatus
  const status = statusValue === undefined ? '' : ` status=${statusValue}`
  const code = typeof record?.code === 'string' ? ` code=${record.code}` : ''

  return `${name}:${status}${code} ${message}`.trim()
}

type QwenAiUpstreamError = Error & {
  status?: number
  type?: string
  param?: string
  code?: string
  headers?: Record<string, string>
  retryable?: boolean
  accountFault?: boolean
}

type QwenAiErrorEnvelopeMetadata = {
  status?: number
  type?: string
  param?: string
  code?: string
  retryable?: boolean
}

function createQwenAiStreamFailure(
  message: string,
  code: 'qwen_ai_stream_incomplete' | 'qwen_ai_empty_stream' = 'qwen_ai_stream_incomplete',
): QwenAiUpstreamError {
  const error = new Error(message) as QwenAiUpstreamError
  // The provider closed its SSE response without a usable completion. This
  // is an upstream gateway failure, not an application exception or a client
  // cancellation, and replaying a slow generation is disabled by default.
  error.status = 502
  error.code = code
  error.retryable = false
  return error
}

function createQwenAiToolValidationError(
  failure: ToolStreamValidationFailure,
): QwenAiUpstreamError {
  const error = new Error(failure.message) as QwenAiUpstreamError
  error.status = 502
  error.type = failure.type
  error.param = failure.param
  error.code = failure.code
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiUndeclaredNativeToolError(names: string[]): QwenAiUpstreamError {
  const uniqueNames = [...new Set(names.filter(Boolean))]
  const error = new Error(
    `Provider returned undeclared native tool call${uniqueNames.length === 1 ? '' : 's'}: ${uniqueNames.join(', ')}`,
  ) as QwenAiUpstreamError
  error.status = 502
  error.type = 'upstream_tool_error'
  error.param = 'tool_calls'
  error.code = 'undeclared_native_tool_call'
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiIncompleteNativeToolError(names: string[]): QwenAiUpstreamError {
  const uniqueNames = [...new Set(names.filter(Boolean))]
  return createQwenAiToolValidationError({
    message: `Provider returned declared native tool call${uniqueNames.length === 1 ? '' : 's'} with incomplete JSON arguments: ${uniqueNames.join(', ')}`,
    type: 'tool_call_parse_error',
    param: 'tool_calls',
    code: 'malformed_tool_call',
  })
}

function normalizeQwenAiStreamFailure(error: unknown): QwenAiUpstreamError {
  const source = error instanceof Error ? error : new Error(String(error))
  const sourceRecord = source as QwenAiUpstreamError
  const declaredStatus = typeof sourceRecord.status === 'number'
    && sourceRecord.status >= 400
    && sourceRecord.status <= 599
    ? sourceRecord.status
    : undefined
  const cancellationCandidate = declaredStatus === undefined
    ? {
        name: source.name,
        code: sourceRecord.code,
        message: source.message,
      }
    : source
  const status = declaredStatus
    ?? (isClientCancellationError(cancellationCandidate)
      ? 499
      : /timed out|timeout|idle for more than/i.test(source.message)
        ? 504
        : 502)

  if (sourceRecord.status === status && typeof sourceRecord.retryable === 'boolean') {
    return sourceRecord
  }

  const normalized = new Error(source.message) as QwenAiUpstreamError
  normalized.name = source.name
  normalized.stack = source.stack
  normalized.status = status
  normalized.retryable = typeof sourceRecord.retryable === 'boolean'
    ? sourceRecord.retryable
    : false
  if (typeof sourceRecord.type === 'string') normalized.type = sourceRecord.type
  if (typeof sourceRecord.param === 'string') normalized.param = sourceRecord.param
  if (typeof sourceRecord.code === 'string') normalized.code = sourceRecord.code
  if (typeof sourceRecord.accountFault === 'boolean') normalized.accountFault = sourceRecord.accountFault
  normalized.headers = sanitizeForwardedErrorHeaders(sourceRecord.headers)
  return normalized
}

function isQwenAiRiskControlMessage(message: string): boolean {
  return /FAIL_SYS_USER_VALIDATE|RGV587|risk-control|challenge|captcha|x5sec|baxia|punish|哎哟喂|被挤爆/i.test(message)
}

function isQwenAiRateLimitMessage(message: string): boolean {
  return /(?:^|\D)429(?:\D|$)|too many requests|rate.?limit|throttl|quota(?:[_\s-]?(?:limit|exceeded|exhausted))?|resource[_\s-]?exhausted/i.test(message)
}

function qwenAiErrorValueText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map(item => qwenAiErrorValueText(item))
      .filter(Boolean)
      .join('; ')
  }
  if (!isObjectValue(value)) return ''

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractQwenAiErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return qwenAiErrorValueText(value)
  if (!isObjectValue(value)) return ''

  const ret = Array.isArray(value.ret)
    ? value.ret.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).join('; ')
    : ''
  const error = value.error
  const errors = value.errors
  const data = isObjectValue(value.data) ? value.data : undefined
  const nestedError = isObjectValue(error)
    ? extractQwenAiErrorMessage(error)
    : qwenAiErrorValueText(error)
  const nestedErrors = qwenAiErrorValueText(errors)
  const nestedData = data ? extractQwenAiErrorMessage(data) : ''
  const directMessage = typeof value.message === 'string' ? value.message.trim() : ''
  const directMsg = typeof value.msg === 'string' ? value.msg.trim() : ''
  const directDetails = typeof value.details === 'string' ? value.details.trim() : ''
  const directDetail = typeof value.detail === 'string' ? value.detail.trim() : ''
  const directReason = typeof value.reason === 'string' ? value.reason.trim() : ''
  const directDescription = typeof value.description === 'string' ? value.description.trim() : ''
  const directCode = typeof value.code === 'string' ? value.code.trim() : ''
  return directMessage
    || directMsg
    || directDetails
    || directDetail
    || directReason
    || directDescription
    || directCode
    || nestedError
    || nestedErrors
    || nestedData
    || ret
}

function redactQwenAiErrorText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"',}]+/gi, '[REDACTED_URL]')
    .replace(/(x5secdata|x5sectag|cookie|authorization|token)=([^&\s"',}]+)/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 500)
}

function readQwenAiEnvelopeStatus(
  record: Record<string, unknown>,
  includeTopLevelCode = true,
): number | undefined {
  const candidates: unknown[] = [
    record.status,
    record.statusCode,
    record.httpStatus,
    record.error,
    record.errors,
  ]
  if (includeTopLevelCode) candidates.splice(3, 0, record.code)

  const visit = (candidate: unknown): number | undefined => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const status = visit(item)
        if (status !== undefined) return status
      }
      return undefined
    }
    if (isObjectValue(candidate)) {
      for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
        const status = visit(candidate[key])
        if (status !== undefined) return status
      }
      return undefined
    }

    const status = typeof candidate === 'number'
      ? candidate
      : typeof candidate === 'string' && /^\d{3}$/.test(candidate.trim())
        ? Number(candidate)
        : undefined
    return status !== undefined && status >= 400 && status <= 599 ? status : undefined
  }

  for (const candidate of candidates) {
    const status = visit(candidate)
    if (status !== undefined) return status
  }

  return undefined
}

function extractQwenAiErrorEnvelopeMetadata(
  sources: unknown[],
): QwenAiErrorEnvelopeMetadata {
  const queue = [...sources]
  const visited = new Set<object>()
  let metadata: QwenAiErrorEnvelopeMetadata = {}

  while (queue.length > 0) {
    const value = queue.shift()
    if (Array.isArray(value)) {
      queue.push(...value)
      continue
    }
    if (!isObjectValue(value) || visited.has(value)) continue
    visited.add(value)

    const stringValue = (candidate: unknown): string | undefined => {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
      return undefined
    }
    metadata = {
      status: metadata.status ?? readQwenAiEnvelopeStatus(value),
      type: metadata.type ?? stringValue(value.type),
      param: metadata.param ?? stringValue(value.param),
      code: metadata.code ?? stringValue(value.code),
      retryable: metadata.retryable ?? (
        typeof value.retryable === 'boolean' ? value.retryable : undefined
      ),
    }

    queue.push(value.error, value.errors, value.data)
  }

  return metadata
}

function createQwenAiStreamEnvelopeError(
  data: unknown,
  raw: string,
  eventType?: string,
): QwenAiUpstreamError | undefined {
  const record = isObjectValue(data) ? data : undefined
  const eventLooksLikeError = typeof eventType === 'string' && /error|fail|reject/i.test(eventType)

  // A non-JSON payload is only an upstream error when the SSE event itself is
  // marked as an error. Normal SSE data must still use the parser's regular
  // JSON error path below.
  if (!record) {
    if (!eventLooksLikeError) return undefined
    const message = typeof data === 'string' ? data.trim() : raw.trim()
    const isRiskControl = isQwenAiRiskControlMessage(message)
    const isRateLimited = isQwenAiRateLimitMessage(message)
    if (!message && !isRiskControl && !isRateLimited) return undefined
    const error = new Error(
      `Qwen AI upstream stream rejected the request: ${redactQwenAiErrorText(message) || 'unknown error'}`,
    ) as QwenAiUpstreamError
    error.status = isRiskControl ? 403 : isRateLimited ? 429 : 502
    error.retryable = false
    if (isRiskControl) {
      error.code = 'qwen_ai_risk_control'
    } else if (isRateLimited) {
      error.code = 'qwen_ai_capacity_limit'
    }
    return error
  }

  const hasErrorField = record.error !== undefined && record.error !== null && record.error !== false
  const hasErrorsField = Array.isArray(record.errors)
    ? record.errors.length > 0
    : record.errors !== undefined && record.errors !== null && record.errors !== false
  const hasRetField = Array.isArray(record.ret) && record.ret.length > 0
  const isOrdinaryResponse = Boolean(
    'choices' in record
    || 'response.created' in record
    || 'usage' in record
  )
  const explicitStatus = readQwenAiEnvelopeStatus(
    record,
    !isOrdinaryResponse || hasErrorField || hasErrorsField || eventLooksLikeError,
  )
  const structuredMessage = extractQwenAiErrorMessage(record)
  const hasStructuredMessage = Boolean(structuredMessage)
  const hasRetError = hasRetField && (
    !isOrdinaryResponse
    || /(?:error|fail|reject|invalid|risk|captcha)/i.test(structuredMessage)
    || isQwenAiRateLimitMessage(structuredMessage)
    || eventLooksLikeError
  )
  const hasExplicitError = Boolean(
    hasErrorField
    || hasErrorsField
    || record.success === false
    || record.ok === false
    || explicitStatus !== undefined
  )
  const hasErrorSignal = Boolean(
    hasExplicitError
    || hasRetError
    || (!isOrdinaryResponse && hasStructuredMessage)
    || (eventLooksLikeError && hasStructuredMessage)
    || (eventLooksLikeError && !isOrdinaryResponse)
  )
  const envelopeMetadata = extractQwenAiErrorEnvelopeMetadata([
    ...(hasErrorField ? [record.error] : []),
    ...(hasErrorsField ? [record.errors] : []),
    ...(!isOrdinaryResponse && hasErrorSignal ? [record] : []),
  ])

  // Completion envelopes may contain arbitrary numeric values (for example
  // usage.output_tokens_details.text_tokens = 429). A completion envelope is
  // ignored unless it carries an explicit error/status or an error message;
  // this also protects normal data sent with a misleading event name.
  if (isOrdinaryResponse && !hasErrorSignal) {
    return undefined
  }

  const classificationEvidence = [
    structuredMessage,
    qwenAiErrorValueText(record.error),
    qwenAiErrorValueText(record.errors),
    qwenAiErrorValueText(record.code),
    qwenAiErrorValueText(record.type),
  ].filter(Boolean).join('; ')
  const isRiskControl = hasErrorSignal && isQwenAiRiskControlMessage(classificationEvidence)
  const isRateLimited = explicitStatus === 429 || (
    hasErrorSignal
    && isQwenAiRateLimitMessage(classificationEvidence)
  )

  if (!isRiskControl && !hasErrorSignal && !isRateLimited) return undefined

  const message = redactQwenAiErrorText(structuredMessage || raw)
  const error = new Error(`Qwen AI upstream stream rejected the request: ${message || 'unknown error'}`) as QwenAiUpstreamError
  error.status = isRiskControl ? 403 : isRateLimited ? 429 : explicitStatus ?? 502
  error.retryable = envelopeMetadata.retryable ?? false
  if (envelopeMetadata.type) error.type = envelopeMetadata.type
  if (envelopeMetadata.param) error.param = envelopeMetadata.param
  if (isRiskControl) {
    error.code = 'qwen_ai_risk_control'
  } else if (isRateLimited) {
    error.code = 'qwen_ai_capacity_limit'
  } else if (envelopeMetadata.code) {
    error.code = envelopeMetadata.code
  }
  return error
}

function findModelCapability(
  provider: Provider,
  requestedModel: string,
  modelId: string,
): ProviderModelCapability | undefined {
  const capabilities = provider.modelCapabilities
  if (!capabilities) return undefined

  // Feature suffixes are client-side aliases, not distinct upstream models.
  // Resolve them to the base model before looking up live capability metadata.
  const normalizeCapabilityKey = (value: string): string => value
    .replace(/(?:-(?:web-search|thinking|think|search|fast|r1))+$/i, '')
    .toLowerCase()

  const candidates = new Set<string>([
    requestedModel,
    modelId,
    requestedModel.replace(/(?:-(?:web-search|thinking|think|search|fast|r1))+$/i, ''),
    modelId.replace(/(?:-(?:web-search|thinking|think|search|fast|r1))+$/i, ''),
  ])
  for (const [displayName, mappedId] of Object.entries(provider.modelMappings || {})) {
    if (
      normalizeCapabilityKey(mappedId) === normalizeCapabilityKey(modelId)
      || normalizeCapabilityKey(displayName) === normalizeCapabilityKey(requestedModel)
    ) {
      candidates.add(displayName)
      candidates.add(mappedId)
    }
  }

  const normalizedCandidates = new Set([...candidates].map(normalizeCapabilityKey))
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(capabilities, candidate)) {
      return capabilities[candidate]
    }
  }
  for (const [key, capability] of Object.entries(capabilities).reverse()) {
    if (normalizedCandidates.has(normalizeCapabilityKey(key))) {
      return capability
    }
  }

  return undefined
}

/**
 * Resolve the feature flag without allowing a client option to request an
 * unsupported fast mode. Qwen's `think_skip.enable=false` means the model
 * requires a reasoning phase, so that provider capability takes precedence
 * over suffixes and translated client parameters.
 */
export function resolveQwenThinkingEnabled(
  requested: boolean | undefined,
  forced: boolean | undefined,
  capability: ProviderModelCapability | undefined,
): boolean {
  if (capability?.thinkingSkippable === false) return true
  return requested ?? forced ?? false
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private tokenRefresher = new QwenAiTokenRefresher()
  private deleteChatRequests = new Map<string, Promise<boolean>>()
  private axiosInstance = axios.create({
    timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private async refreshTokenIfNeeded(signal?: AbortSignal): Promise<void> {
    this.account = await this.tokenRefresher.refreshIfNeeded(this.account, signal)
  }

  private async postWithRefreshRetry(
    url: string,
    payload: unknown,
    createOptions: () => Record<string, any>,
  ): Promise<AxiosResponse> {
    let options = createOptions()
    let response = await this.axiosInstance.post(url, payload, options)

    if (response.status === 401) {
      this.account = await this.tokenRefresher.refreshAfterUnauthorized(this.account, options.signal)
      options = createOptions()
      response = await this.axiosInstance.post(url, payload, options)
    }

    return response
  }

  private async getWithRefreshRetry(
    url: string,
    createOptions: () => Record<string, any>,
  ): Promise<AxiosResponse> {
    let options = createOptions()
    let response = await this.axiosInstance.get(url, options)

    if (response.status === 401) {
      destroyReadableStream(response.data)
      this.account = await this.tokenRefresher.refreshAfterUnauthorized(this.account, options.signal)
      options = createOptions()
      response = await this.axiosInstance.get(url, options)
    }

    return response
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    const cookies = credentials.cookies || credentials.cookie || ''
    if (typeof cookies === 'string') {
      return cookies
    }
    if (isObjectValue(cookies)) {
      return Object.entries(cookies)
        .filter(([, value]) => typeof value === 'string' && value)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
    }
    return ''
  }

  private getCredentialValue(...keys: string[]): string {
    const credentials = this.account.credentials
    for (const key of keys) {
      const value = credentials[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return ''
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const cookies = this.getCookies()
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'X-Request-Id': uuid(),
      Timezone: currentTimezoneHeader(),
    }

    const token = this.getToken()
    // The current Qwen web frontend sets source=web and removes Authorization for
    // browser sessions. Sending browser cookies together with desktop bearer auth
    // is more likely to hit upstream risk control.
    if (token && !cookies) {
      headers.source = 'desktop'
      headers.Authorization = `Bearer ${token}`
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const baxiaUidToken = this.getCredentialValue('baxiaUidToken', 'baxia_uid_token', 'uidToken')
    if (baxiaUidToken) {
      headers['bx-umidtoken'] = baxiaUidToken
    }

    const baxiaUa = this.getCredentialValue('baxiaUa', 'baxia_ua', 'bxUa', 'bx_ua')
    if (baxiaUa) {
      headers['bx-ua'] = baxiaUa
    }

    const baxiaVersion = this.getCredentialValue('baxiaVersion', 'baxia_version', 'bxV', 'bx_v')
    if (baxiaVersion) {
      headers['bx-v'] = baxiaVersion
    }

    const x5secdata = this.getCredentialValue('x5secdata')
    if (x5secdata) {
      headers['x5secdata'] = x5secdata
    }

    const x5sectag = this.getCredentialValue('x5sectag')
    if (x5sectag) {
      headers['x5sectag'] = x5sectag
    }

    if (cookies) {
      headers['Cookie'] = cookies
    } else if (!token) {
      console.warn('[QwenAI] Warning: No token or cookies provided. Requests may fail authentication.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  private sanitizeHeadersForLog(headers: Record<string, any>): Record<string, unknown> {
    const sensitiveHeaders = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'bx-ua',
      'bx-umidtoken',
      'x5secdata',
      'x5sectag',
    ])

    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        sensitiveHeaders.has(key.toLowerCase()) ? '[REDACTED]' : value,
      ]),
    )
  }

  private sanitizePayloadForLog(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.sanitizePayloadForLog(item))
    }

    if (typeof value === 'string' && value.includes(QWEN_AI_DOCUMENT_EVIDENCE_MARKER)) {
      return `${value.slice(0, value.indexOf(QWEN_AI_DOCUMENT_EVIDENCE_MARKER))}${QWEN_AI_DOCUMENT_EVIDENCE_MARKER}\n[REDACTED_DOCUMENT_EVIDENCE]`
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          key === 'url' ? '[REDACTED_URL]' : this.sanitizePayloadForLog(item),
        ]),
      )
    }

    return value
  }

  private summarizePayloadForLog(payload: Record<string, any>): Record<string, unknown> {
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const primaryMessage = messages[0] || {}
    const content = primaryMessage.content
    const contentChars = typeof content === 'string'
      ? content.length
      : (() => {
          try {
            return JSON.stringify(content || '').length
          } catch {
            return 0
          }
        })()

    return {
      stream: payload.stream,
      model: payload.model,
      chat_id: payload.chat_id,
      chat_mode: payload.chat_mode,
      messageCount: messages.length,
      contentChars,
      fileCount: Array.isArray(primaryMessage.files) ? primaryMessage.files.length : 0,
      feature_config: primaryMessage.feature_config,
      timestamp: payload.timestamp,
    }
  }

  private async readStreamPreview(stream: any, maxBytes = 4096): Promise<string> {
    if (!stream) return ''
    if (typeof stream === 'string') return stream.slice(0, maxBytes)
    if (Buffer.isBuffer(stream)) return stream.toString('utf8', 0, maxBytes)
    if (typeof stream !== 'object' || typeof stream.on !== 'function') {
      try {
        return JSON.stringify(stream).slice(0, maxBytes)
      } catch {
        return String(stream).slice(0, maxBytes)
      }
    }

    const chunks: Buffer[] = []
    let total = 0

    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }

      stream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const remaining = maxBytes - total
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining))
          total += Math.min(buffer.length, remaining)
        }
        if (total >= maxBytes && typeof stream.destroy === 'function') {
          stream.destroy()
        }
      })
      stream.once('end', finish)
      stream.once('close', finish)
      stream.once('error', finish)
    })

    return Buffer.concat(chunks).toString('utf8')
  }

  private extractUpstreamErrorMessage(body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return ''

    try {
      const parsed = JSON.parse(trimmed)
      const message = extractQwenAiErrorMessage(parsed)
      if (message) return message
    } catch {
      // Fall back to a compact body preview below.
    }

    return redactQwenAiErrorText(trimmed)
  }

  private hasRiskControlHeaders(headers: Record<string, any>): boolean {
    const setCookie = headers['set-cookie']
    const setCookieText = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie || '')

    return Boolean(
      headers.bxpunish ||
      headers['bxpunish'] ||
      headers['x5secdata'] ||
      headers['x5sectag'] ||
      /x5sec/i.test(setCookieText),
    )
  }

  private isRiskControlMessage(message: string): boolean {
    return isQwenAiRiskControlMessage(message)
  }

  private async createInvalidStreamError(response: AxiosResponse, reason: string): Promise<Error> {
    const contentType = String(response.headers?.['content-type'] || 'unknown')
    const body = await this.readStreamPreview(response.data)
    const upstreamMessage = this.extractUpstreamErrorMessage(body)
    const detail = upstreamMessage ? `: ${upstreamMessage}` : ''

    let envelopeError: QwenAiUpstreamError | undefined
    try {
      envelopeError = createQwenAiStreamEnvelopeError(JSON.parse(body), body, 'error')
    } catch {
      envelopeError = createQwenAiStreamEnvelopeError(body, body, 'error')
    }

    const isRiskControl = envelopeError?.status === 403
      || this.isRiskControlMessage(upstreamMessage)
      || reason.includes('risk-control')
    const isCapacityLimit = response.status === 429 || envelopeError?.status === 429
    const upstreamStatus = response.status >= 400 && response.status <= 599
      ? response.status
      : 502
    const error = new Error(`Qwen AI upstream ${reason} (HTTP ${response.status}, content-type ${contentType})${detail}`) as QwenAiUpstreamError
    // Preserve only retry pacing metadata. The governor uses Retry-After to
    // distinguish ordinary quota throttling without exposing upstream cookies
    // or transport headers to the client.
    error.status = isRiskControl ? 403 : isCapacityLimit ? 429 : upstreamStatus
    error.headers = sanitizeForwardedErrorHeaders(response.headers)
    error.retryable = envelopeError?.retryable ?? false
    if (envelopeError?.type) error.type = envelopeError.type
    if (envelopeError?.param) error.param = envelopeError.param
    if (isRiskControl) {
      error.code = 'qwen_ai_risk_control'
    } else if (isCapacityLimit) {
      error.code = 'qwen_ai_capacity_limit'
    } else if (envelopeError?.code) {
      error.code = envelopeError.code
    }
    return error
  }

  private async assertChatCompletionStreamResponse(response: AxiosResponse): Promise<void> {
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()

    if (response.status >= 400) {
      throw await this.createInvalidStreamError(response, `returned HTTP ${response.status}`)
    }

    if (this.hasRiskControlHeaders(response.headers || {})) {
      throw await this.createInvalidStreamError(response, 'returned a risk-control or challenge response instead of a chat event stream')
    }

    if (contentType.includes('application/json') || contentType.includes('text/html')) {
      throw await this.createInvalidStreamError(response, 'returned a non-stream response instead of a chat event stream')
    }
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(modelId: string, title: string = 'New Chat', signal?: AbortSignal): Promise<string> {
    await this.refreshTokenIfNeeded(signal)

    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.postWithRefreshRetry(url, payload, () => ({
        headers: this.getHeaders(),
        signal,
        validateStatus: () => true,
      }))

      if (response.status >= 400) {
        throw await this.createInvalidStreamError(response, `chat creation returned HTTP ${response.status}`)
      }

      if (QWEN_AI_DEBUG_REQUEST_LOGS) {
        console.log('[QwenAI] Create chat response:', JSON.stringify(response.data, null, 2))
      }

      if (response.data?.data?.id) {
        if (QWEN_AI_DEBUG_REQUEST_LOGS) {
          console.log('[QwenAI] Created chat:', response.data.data.id)
        }
        return response.data.data.id
      }

      throw new Error('Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', describeErrorForLog(error))
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const existingRequest = this.deleteChatRequests.get(chatId)
    if (existingRequest) {
      return existingRequest
    }

    const request = this.performDeleteChat(chatId)
    this.deleteChatRequests.set(chatId, request)
    return request
  }

  private async performDeleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', describeErrorForLog(error))
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', describeErrorForLog(error))
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    await this.refreshTokenIfNeeded(request.signal)

    const token = this.getToken()
    if (!token) {
      const error = new Error('Qwen AI token not configured, please add token in account settings') as QwenAiUpstreamError
      error.status = 401
      error.retryable = false
      throw error
    }

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.6-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    // Always create a new chat (single-turn mode only)
    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat', request.signal)
    if (QWEN_AI_DEBUG_REQUEST_LOGS) {
      console.log('[QwenAI] Created new chat:', chatId)
    }

    try {
      const messages = request.messages
      const uploader = new QwenAiFileUploader(
        this.axiosInstance,
        () => this.getHeaders(chatId),
        this.postWithRefreshRetry.bind(this),
        { providerId: this.provider.id, accountId: this.account.id },
      )
      const preparedUserMessage = await prepareQwenAiMultimodalMessage(messages, uploader)
      const qwenFiles = preparedUserMessage.files

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // The live model capability is authoritative when the upstream model does
    // not support skipping its reasoning phase.
    const modelCapability = findModelCapability(this.provider, modelForThinking, modelId)
    const shouldEnableThinking = resolveQwenThinkingEnabled(
      request.enable_thinking,
      forceThinking,
      modelCapability,
    )
    
    const featureConfig: Record<string, any> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false, // Default to disable auto search
    }

    if (request.thinking_budget) {
      featureConfig.thinking_budget = request.thinking_budget
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: preparedUserMessage.content,
          user_action: 'chat',
          files: qwenFiles,
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

    if (QWEN_AI_DEBUG_REQUEST_LOGS || QWEN_AI_DEBUG_PAYLOAD_LOGS) {
      console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
      console.log('[QwenAI] Request URL:', url)
      if (QWEN_AI_DEBUG_PAYLOAD_LOGS) {
        console.log('[QwenAI] Request payload:', JSON.stringify(this.sanitizePayloadForLog(payload), null, 2))
      } else {
        console.log('[QwenAI] Request payload summary:', JSON.stringify(this.summarizePayloadForLog(payload), null, 2))
      }
      console.log('[QwenAI] Request headers:', JSON.stringify(this.sanitizeHeadersForLog(this.getHeaders(chatId)), null, 2))
    }

    const response = await this.postWithRefreshRetry(url, payload, () => ({
      headers: {
        ...this.getHeaders(chatId),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
      signal: request.signal,
      validateStatus: () => true,
    }))

    if (QWEN_AI_DEBUG_REQUEST_LOGS) {
      console.log('[QwenAI] Response status:', response.status)
      console.log('[QwenAI] Response headers:', JSON.stringify(this.sanitizeHeadersForLog(response.headers), null, 2))
    }

    await this.assertChatCompletionStreamResponse(response)

      return {
        response,
        chatId,
        parentId: null,
      }
    } catch (error) {
      await this.deleteChat(chatId)
      throw error
    }
  }

  /**
   * Resume an in-progress Qwen response after the transport drops. This is
   * the same response-id based endpoint used by Qwen's web client; it does
   * not submit the prompt a second time or duplicate tool execution.
   */
  async resumeChatCompletion(
    chatId: string,
    responseId: string,
    signal?: AbortSignal,
  ): Promise<AxiosResponse> {
    if (!chatId || !responseId) {
      throw new Error('Qwen AI resume requires both chat ID and response ID')
    }

    await this.refreshTokenIfNeeded(signal)

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}&response_id=${encodeURIComponent(responseId)}`
    const response = await this.getWithRefreshRetry(url, () => ({
      headers: {
        ...this.getHeaders(chatId),
        Accept: 'text/event-stream',
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
      signal,
      validateStatus: () => true,
    }))

    if (QWEN_AI_DEBUG_REQUEST_LOGS) {
      console.log('[QwenAI] Resume response status:', response.status)
      console.log('[QwenAI] Resume response headers:', JSON.stringify(this.sanitizeHeadersForLog(response.headers)))
    }

    await this.assertChatCompletionStreamResponse(response)
    return response
  }

  async startDirectFileUpload(input: QwenAiDirectUploadInput): Promise<QwenAiDirectUploadStartResult> {
    await this.refreshTokenIfNeeded()

    const token = this.getToken()
    if (!token && !this.getCookies()) {
      throw new Error('Qwen AI token/cookies not configured, please add credentials in account settings')
    }

    const uploader = new QwenAiFileUploader(
      this.axiosInstance,
      () => this.getHeaders(),
      this.postWithRefreshRetry.bind(this),
      { providerId: this.provider.id, accountId: this.account.id },
    )
    return uploader.startDirectUpload(input)
  }

  async completeDirectFileUpload(sessionId: string): Promise<any> {
    await this.refreshTokenIfNeeded()

    const uploader = new QwenAiFileUploader(
      this.axiosInstance,
      () => this.getHeaders(),
      this.postWithRefreshRetry.bind(this),
      { providerId: this.provider.id, accountId: this.account.id },
    )
    return uploader.completeDirectUpload(sessionId)
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private toolCallsSent: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private nativeToolCallStates = new Map<string, NativeToolCallState>()
  private nativeToolCallIndex = 0
  private warnedUndeclaredNativeToolNames = new Set<string>()
  private ignoredResponseIds = new Set<string>()
  private responseBranchLocked = false
  private processedResponseEvent = false
  private streamCompleted = false
  private readonly toolCallIdPrefix: string

  constructor(model: string, onEnd?: (chatId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolCallIdPrefix = `call_${uuid().replace(/-/g, '')}`
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse
      ? new ToolStreamParser(toolCallingPlan, this.toolCallIdPrefix)
      : undefined
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  private getResponseIndex(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    return String(value)
  }

  private getEventResponseId(data: Record<string, any>): string {
    const responseId = data.response_id ?? data['response.created']?.response_id
    return typeof responseId === 'string' ? responseId : ''
  }

  private getEventResponseIndex(data: Record<string, any>): string | undefined {
    return this.getResponseIndex(data.response_index ?? data['response.created']?.response_index)
  }

  private hasStartedResponseOutput(): boolean {
    return Boolean(this.processedResponseEvent || this.content || this.toolCallsSent || this.nativeToolCallStates.size > 0)
  }

  private setPrimaryResponseBranch(responseId: string, responseIndex?: string): void {
    this.responseId = responseId
    this.ignoredResponseIds.delete(responseId)

    if (responseIndex === '0') {
      this.responseBranchLocked = true
    }

    console.log('[QwenAI] Got response_id:', this.responseId, 'response_index:', responseIndex ?? 'unknown')
  }

  private ignoreResponseBranch(responseId: string, responseIndex?: string): void {
    if (!responseId) return

    const firstIgnoredEvent = !this.ignoredResponseIds.has(responseId)
    this.ignoredResponseIds.add(responseId)

    if (firstIgnoredEvent) {
      console.warn('[QwenAI] Ignoring secondary response branch:', {
        responseId,
        responseIndex: responseIndex ?? 'unknown',
        primaryResponseId: this.responseId || 'unselected',
      })
    }
  }

  private recordResponseCreated(created: Record<string, any>): boolean {
    const responseId = typeof created.response_id === 'string' ? created.response_id : ''
    if (!responseId) return false

    const responseIndex = this.getResponseIndex(created.response_index)

    if (!this.responseId) {
      if (responseIndex && responseIndex !== '0') {
        this.ignoreResponseBranch(responseId, responseIndex)
        return false
      }

      this.setPrimaryResponseBranch(responseId, responseIndex)
      return true
    }

    if (responseId === this.responseId) {
      if (responseIndex === '0') {
        this.responseBranchLocked = true
      }
      return true
    }

    if (responseIndex === '0' && !this.responseBranchLocked && !this.hasStartedResponseOutput()) {
      this.ignoreResponseBranch(this.responseId, undefined)
      this.setPrimaryResponseBranch(responseId, responseIndex)
      return true
    }

    this.ignoreResponseBranch(responseId, responseIndex)
    return false
  }

  private shouldProcessResponseEvent(data: Record<string, any>): boolean {
    const eventResponseId = this.getEventResponseId(data)
    const eventResponseIndex = this.getEventResponseIndex(data)

    if (!eventResponseId) {
      if (eventResponseIndex && eventResponseIndex !== '0') {
        console.warn('[QwenAI] Ignoring secondary response branch without response_id:', {
          responseIndex: eventResponseIndex,
          primaryResponseId: this.responseId || 'unselected',
        })
        return false
      }

      this.processedResponseEvent = true
      return true
    }

    if (this.ignoredResponseIds.has(eventResponseId)) {
      return false
    }

    if (!this.responseId) {
      if (eventResponseIndex && eventResponseIndex !== '0') {
        this.ignoreResponseBranch(eventResponseId, eventResponseIndex)
        return false
      }

      this.setPrimaryResponseBranch(eventResponseId, eventResponseIndex)
      this.processedResponseEvent = true
      return true
    }

    if (eventResponseId !== this.responseId) {
      this.ignoreResponseBranch(eventResponseId, eventResponseIndex)
      return false
    }

    this.processedResponseEvent = true
    return true
  }

  private sendToolCalls(transStream: PassThrough): boolean {
    if (this.toolCallsSent) return true
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const tool = this.toolCallingPlan?.tools?.find(item => item.name === tc.function.name)
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: `${this.toolCallIdPrefix}_${i}`,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: normalizeArguments(tc.function.arguments, tool),
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
      return true
    }

    return false
  }

  private ingestNativeToolCallFragments(delta: Record<string, any>): {
    sawFragment: boolean
    declaredProgress: boolean
  } {
    if (!this.toolCallingPlan?.shouldParseResponse) {
      return { sawFragment: false, declaredProgress: false }
    }

    const fragments = normalizeNativeFunctionCallDelta(delta)
    let sawFragment = false
    let declaredProgress = false

    for (const fragment of fragments) {
      sawFragment = true
      const existing = this.nativeToolCallStates.get(fragment.key)
      const name = fragment.name || existing?.name || ''
      const allowed = Boolean(name && this.toolCallingPlan.allowedToolNames.has(name))
      const argumentsText = mergeNativeToolArguments(existing?.arguments ?? '', fragment.arguments)
      const nextState: NativeToolCallState = {
        key: fragment.key,
        id: existing?.id || `${this.toolCallIdPrefix}_${this.nativeToolCallIndex}`,
        index: fragment.index ?? existing?.index ?? this.nativeToolCallIndex,
        name,
        arguments: argumentsText,
        allowed,
      }

      if (!existing) {
        this.nativeToolCallIndex += 1
      }

      this.nativeToolCallStates.set(fragment.key, nextState)
      if (allowed && (
        !existing
        || existing.name !== nextState.name
        || existing.arguments !== nextState.arguments
        || !existing.allowed
      )) {
        declaredProgress = true
      }

      if (name && !allowed && !this.warnedUndeclaredNativeToolNames.has(name)) {
        this.warnedUndeclaredNativeToolNames.add(name)
        console.warn('[QwenAI] Ignoring undeclared upstream native tool call:', name)
      }
    }

    return { sawFragment, declaredProgress }
  }

  private getUndeclaredNativeToolNames(): string[] {
    const names = new Set<string>()
    for (const state of this.nativeToolCallStates.values()) {
      if (state.name && !state.allowed) names.add(state.name)
    }
    return [...names]
  }

  private getIncompleteDeclaredNativeToolNames(): string[] {
    const names = new Set<string>()
    for (const state of this.nativeToolCallStates.values()) {
      if (state.allowed && state.name && !isCompleteJsonText(state.arguments)) {
        names.add(state.name)
      }
    }
    return [...names]
  }

  private getCompleteNativeToolCalls(force: boolean = false): ToolCall[] {
    const toolCalls: ToolCall[] = []

    for (const state of this.nativeToolCallStates.values()) {
      if (!state.allowed || !state.name) continue
      if (!force && !isCompleteJsonText(state.arguments)) continue

      // Native provider calls bypass ToolCallingEngine's managed-protocol
      // parser. Normalize their complete arguments against the declared
      // client schema before exposing them to the downstream tool validator.
      const tool = this.toolCallingPlan?.tools?.find(item => item.name === state.name)

      toolCalls.push({
        index: state.index,
        id: state.id,
        type: 'function',
        function: {
          name: state.name,
          arguments: normalizeArguments(state.arguments, tool),
        },
      })
    }

    return toolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  }

  private emitNativeToolCalls(transStream: PassThrough, toolCalls: ToolCall[]): boolean {
    if (this.toolCallsSent || toolCalls.length === 0) return false

    this.toolCallsSent = true

    for (let i = 0; i < toolCalls.length; i += 1) {
      const toolCall = toolCalls[i]
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: i === 0 ? 'assistant' : undefined,
              tool_calls: [toolCall],
            },
            finish_reason: null,
          }],
          created: this.created,
        })}\n\n`,
      )
    }

    transStream.write(
      `data: ${JSON.stringify({
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        created: this.created,
      })}\n\n`,
    )
    transStream.end('data: [DONE]\n\n')

    if (this.onEnd && this.chatId) {
      this.onEnd(this.chatId)
    }

    return true
  }

  async handleStream(stream: any, options: StreamHandlingOptions = {}): Promise<QwenAiOutputStream> {
    const transStream: QwenAiOutputStream = new PassThrough()

    if (QWEN_AI_DEBUG_STREAM_LOGS) {
      console.log('[QwenAI] Starting stream handler...')
    }

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let initialChunkSent = false
    let finalChunkSent = false
    let sawUpstreamCompletion = false
    let responseTimer: NodeJS.Timeout | undefined
    let idleTimer: NodeJS.Timeout | undefined
    let idleRecoveryInFlight = false
    const responseTimeoutMs = options.responseTimeoutMs ?? QWEN_AI_RESPONSE_TIMEOUT_MS

    const cleanupTimers = () => {
      if (responseTimer) {
        clearTimeout(responseTimer)
        responseTimer = undefined
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    const recordStreamFailure = (error: Error): boolean => {
      if (finalChunkSent) return false
      const description = describeErrorForLog(error)
      if (isClientCancellationError(error)) {
        console.log('[QwenAI] Stream cancelled:', description)
      } else {
        console.error('[QwenAI] Stream failed:', description)
      }
      finalChunkSent = true
      cleanupTimers()
      transStream.qwenAiFailure = error
      transStream.emit(QWEN_AI_STREAM_FAILURE_EVENT, error)
      options.onFailure?.(error)
      return true
    }

    const failStream = (error: Error) => {
      const upstreamError = normalizeQwenAiStreamFailure(error)
      if (!recordStreamFailure(upstreamError)) return
      const errorCode = typeof upstreamError.code === 'string'
        ? upstreamError.code
        : 'qwen_ai_stream_error'
      const errorStatus = typeof upstreamError.status === 'number'
        && upstreamError.status >= 400
        && upstreamError.status <= 599
        ? upstreamError.status
        : undefined
      const errorRetryable = typeof upstreamError.retryable === 'boolean'
        ? upstreamError.retryable
        : undefined
      const errorAccountFault = typeof upstreamError.accountFault === 'boolean'
        ? upstreamError.accountFault
        : undefined
      const errorType = typeof upstreamError.type === 'string'
        ? upstreamError.type
        : 'upstream_stream_error'
      const errorParam = typeof upstreamError.param === 'string'
        ? upstreamError.param
        : undefined
      transStream.write(`event: error\ndata: ${JSON.stringify({
        error: {
          message: upstreamError.message,
          type: errorType,
          code: errorCode,
          ...(errorParam === undefined ? {} : { param: errorParam }),
          ...(errorStatus === undefined ? {} : { status: errorStatus }),
          ...(errorRetryable === undefined ? {} : { retryable: errorRetryable }),
          ...(errorAccountFault === undefined ? {} : { accountFault: errorAccountFault }),
        },
      })}\n\n`)
      transStream.end('data: [DONE]\n\n')

      // Queue the failure frame before destroying the source. Destroying an
      // Axios response with the same error first can race a downstream SSE
      // bridge and turn a recoverable stream error into a bare ECONNRESET.
      destroyReadableStream(stream, upstreamError)
    }

    const handleIdle = async () => {
      if (finalChunkSent || idleRecoveryInFlight) return
      idleTimer = undefined
      const idleError = new Error(
        `Qwen AI response stream was idle for more than ${Math.ceil((options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS) / 1000)}s.`,
      )

      if (!options.recoverFromIdle) {
        failStream(idleError)
        return
      }

      idleRecoveryInFlight = true
      try {
        const recovered = await options.recoverFromIdle(idleError)
        if (recovered) {
          if (!finalChunkSent) refreshIdleTimer()
          return
        }
        if (!finalChunkSent) failStream(idleError)
      } catch (error) {
        if (!finalChunkSent) {
          failStream(error instanceof Error ? error : idleError)
        }
      } finally {
        idleRecoveryInFlight = false
      }
    }

    const refreshIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(() => {
        void handleIdle()
      }, options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS)
    }

    const onAbort = () => {
      failStream(new Error('Qwen AI response stream aborted because the client disconnected.'))
    }

    if (options.signal?.aborted) {
      failStream(new Error('Qwen AI response stream aborted before reading started.'))
      return transStream
    }

    if (responseTimeoutMs > 0) {
      responseTimer = setTimeout(() => {
        failStream(new Error(`Qwen AI response stream timed out after ${Math.ceil(responseTimeoutMs / 1000)}s.`))
      }, responseTimeoutMs)
    }
    refreshIdleTimer()

    options.signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      cleanupTimers()
      options.signal?.removeEventListener('abort', onAbort)
    }

    const completeStream = () => {
      this.streamCompleted = true
      finalChunkSent = true
      cleanup()
      destroyReadableStream(stream)
    }

    const writeContent = (content: string) => {
      if (!content || finalChunkSent) return

      this.content += content

      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const outputChunks = this.toolStreamParser?.push(content, baseChunk, !initialChunkSent) ?? [
        {
          ...baseChunk,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        },
      ]

      for (const outputChunk of outputChunks) {
        transStream.write(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }

      if (outputChunks.length > 0) {
        initialChunkSent = true
        if (QWEN_AI_DEBUG_STREAM_LOGS) {
          console.log('[QwenAI] Content/tool chunk written')
        }
      }
    }

    const finishAnswer = (finishReason: string = 'stop') => {
      if (finalChunkSent) return

      const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
      if (incompleteDeclaredNativeToolNames.length > 0) {
        failStream(createQwenAiIncompleteNativeToolError(incompleteDeclaredNativeToolNames))
        return
      }

      const completeNativeToolCalls = this.getCompleteNativeToolCalls()
      if (completeNativeToolCalls.length > 0 && this.emitNativeToolCalls(transStream, completeNativeToolCalls)) {
        completeStream()
        return
      }

      const hadPendingToolProtocol = this.toolStreamParser?.hasPendingToolProtocol() ?? false

      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outputChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }

      const recoveredToolChunks = this.toolStreamParser?.recoverFromContent(this.content, baseChunk, !initialChunkSent) ?? []
      for (const outputChunk of recoveredToolChunks) {
        transStream.write(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }
      if (recoveredToolChunks.length > 0) {
        initialChunkSent = true
        console.log('[QwenAI] Recovered tool call from accumulated answer content')
      }

      if (hasToolUse(this.content)) {
        console.log('[QwenAI] Found legacy tool_use in stream, sending tool_calls')
        if (this.sendToolCalls(transStream)) {
          completeStream()
          return
        }
      }

      const emittedToolCall = this.toolStreamParser?.hasEmittedToolCall() ?? false
      const validationFailure = getToolStreamValidationFailure({
        plan: this.toolCallingPlan,
        emittedToolCall,
        pendingToolProtocol: hadPendingToolProtocol,
      })
      if (validationFailure) {
        failStream(createQwenAiToolValidationError(validationFailure))
        return
      }

      const hasAnswerOrTool = Boolean(this.content.trim() || emittedToolCall)
      const undeclaredNativeToolNames = this.getUndeclaredNativeToolNames()
      if (undeclaredNativeToolNames.length > 0 && !hasAnswerOrTool) {
        failStream(createQwenAiUndeclaredNativeToolError(undeclaredNativeToolNames))
        return
      }

      const hasUsableOutput = Boolean(hasAnswerOrTool || reasoningText.trim() || summaryText.trim())
      if (!hasUsableOutput) {
        failStream(createQwenAiStreamFailure(
          'Qwen AI returned an empty response stream without answer, reasoning, or tool calls',
          'qwen_ai_empty_stream',
        ))
        return
      }

      const resolvedFinishReason = emittedToolCall
        ? 'tool_calls'
        : finishReason
      const finalChunk = {
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: resolvedFinishReason }],
        created: this.created,
      }
      transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
      transStream.end('data: [DONE]\n\n')
      completeStream()

      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
    }

    const sendInitialChunk = () => {
      if (!initialChunkSent && !this.toolStreamParser) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        transStream.write(initialChunk)
        initialChunkSent = true
        if (QWEN_AI_DEBUG_STREAM_LOGS) {
          console.log('[QwenAI] Initial chunk written')
        }
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          if (finalChunkSent) {
            return
          }

          if (typeof event.data !== 'string' || event.data.trim() === '') {
            return
          }

          if (QWEN_AI_DEBUG_STREAM_LOGS) {
            console.log('[QwenAI] Parsed event:', event.event, 'data:', event.data?.substring(0, 200))
          }
          
          if (event.data === '[DONE]') {
            console.log('[QwenAI] Received [DONE] signal')
            refreshIdleTimer()
            sawUpstreamCompletion = true
            finishAnswer('stop')
            return
          }

          let data: any
          try {
            data = JSON.parse(event.data)
          } catch (parseError) {
            const envelopeError = createQwenAiStreamEnvelopeError(event.data, event.data, event.event)
            if (envelopeError) {
              failStream(envelopeError)
              return
            }
            throw parseError
          }
          const envelopeError = createQwenAiStreamEnvelopeError(data, event.data, event.event)
          if (envelopeError) {
            failStream(envelopeError)
            return
          }
          if (QWEN_AI_DEBUG_STREAM_LOGS) {
            console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))
          }

          if (data['response.created']) {
            this.recordResponseCreated(data['response.created'])
          }

          if (data.choices && data.choices.length > 0) {
            if (!this.shouldProcessResponseEvent(data)) {
              return
            }

            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            const content = delta.content || ''

            if (QWEN_AI_DEBUG_STREAM_LOGS) {
              console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content:', content.substring(0, 50))
            }

            const previousSummaryLength = summaryText.length
            const nativeToolProgress = this.ingestNativeToolCallFragments(delta)
            if (isMeaningfulQwenAiEvent(event, previousSummaryLength) || nativeToolProgress.declaredProgress) {
              refreshIdleTimer()
            }

            if (nativeToolProgress.sawFragment) {
              const completeNativeToolCalls = this.getCompleteNativeToolCalls()
              const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
              if (
                incompleteDeclaredNativeToolNames.length === 0
                && completeNativeToolCalls.length > 0
                && this.emitNativeToolCalls(transStream, completeNativeToolCalls)
              ) {
                completeStream()
                return
              }

              if (!content && status !== 'finished') {
                return
              }
            }

            if (phase === 'think') {
              if (status !== 'finished' && content) {
                // Stream thinking content as reasoning_content in real-time
                reasoningText += content
                if (!hasSentReasoning) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                  hasSentReasoning = true
                  console.log('[QwenAI] Sent reasoning role chunk')
                }
                transStream.write(
                  `data: ${JSON.stringify({
                    id: this.responseId || this.chatId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
                    created: this.created,
                  })}\n\n`
                )
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              if (QWEN_AI_DEBUG_STREAM_LOGS) {
                console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              }
              if (extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  // Send only the incremental diff as reasoning_content
                  const diff = newSummary.substring(summaryText.length)
                  if (diff) {
                    if (!hasSentReasoning) {
                      transStream.write(
                        `data: ${JSON.stringify({
                          id: this.responseId || this.chatId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`
                      )
                      hasSentReasoning = true
                    }
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.chatId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { reasoning_content: diff }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`
                    )
                  }
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer') {
              if (content && !initialChunkSent) sendInitialChunk()
              if (QWEN_AI_DEBUG_STREAM_LOGS) {
                console.log('[QwenAI] Entering answer branch, content:', content)
              }
              writeContent(content)
            } else if (phase === null && content) {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              writeContent(content)
            }

            if (status === 'finished' && (phase === 'answer' || phase === null)) {
              sawUpstreamCompletion = true
              finishAnswer(delta.finish_reason || 'stop')
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', describeErrorForLog(err))
          failStream(err instanceof Error ? err : new Error('Qwen AI stream event could not be parsed'))
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      const text = buffer.toString()
      if (QWEN_AI_DEBUG_STREAM_LOGS) {
        console.log('[QwenAI] Raw stream data:', text.substring(0, 500))
      }
      parser.feed(text)
    })
    stream.once('error', (err: Error) => {
      if (finalChunkSent) {
        return
      }
      const description = describeErrorForLog(err)
      if (isClientCancellationError(err)) {
        console.log('[QwenAI] Stream cancelled:', description)
      } else {
        console.error('[QwenAI] Stream error:', description)
      }
      failStream(err)
    })
    stream.once('end', () => {
      if (QWEN_AI_DEBUG_STREAM_LOGS) {
        console.log('[QwenAI] Stream ended')
      }
      if (!finalChunkSent) {
        if (sawUpstreamCompletion) {
          finishAnswer('stop')
        } else {
          failStream(createQwenAiStreamFailure('Qwen AI response stream ended before an upstream completion signal'))
        }
      }
    })
    stream.once('close', () => {
      if (QWEN_AI_DEBUG_STREAM_LOGS) {
        console.log('[QwenAI] Stream closed')
      }
      if (!finalChunkSent) {
        if (sawUpstreamCompletion) {
          finishAnswer('stop')
        } else {
          failStream(createQwenAiStreamFailure('Qwen AI response stream closed before an upstream completion signal'))
        }
      }
    })
    transStream.once('close', () => {
      cleanup()
      if (!finalChunkSent) {
        const error = new Error('Qwen AI downstream stream closed before upstream completed.')
        const normalized = normalizeQwenAiStreamFailure(error)
        recordStreamFailure(normalized)
        destroyReadableStream(stream, normalized)
      }
    })

    return transStream
  }

  async handleNonStream(stream: any, options: StreamHandlingOptions = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let reasoningText = ''
      let summaryText = ''
      let resolved = false
      let sawAnswerFinish = false
      let sawUpstreamCompletion = false
      let responseTimer: NodeJS.Timeout | undefined
      let idleTimer: NodeJS.Timeout | undefined
      let idleRecoveryInFlight = false
      const responseTimeoutMs = options.responseTimeoutMs ?? QWEN_AI_RESPONSE_TIMEOUT_MS

      const cleanupTimers = () => {
        if (responseTimer) {
          clearTimeout(responseTimer)
          responseTimer = undefined
        }
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = undefined
        }
      }

      const cleanup = () => {
        cleanupTimers()
        options.signal?.removeEventListener('abort', onAbort)
      }

      const resolveOnce = (value: any) => {
        if (!resolved) {
          resolved = true
          this.streamCompleted = true
          cleanup()
          destroyReadableStream(stream)
          resolve(value)
        }
      }

      const finishNativeToolCalls = (): boolean => {
        const toolCalls = this.getCompleteNativeToolCalls()
        if (toolCalls.length === 0) return false

        const choice = data.choices[0]
        const response = {
          ...data,
          choices: [{
            ...choice,
            message: {
              ...choice.message,
              content: null,
              tool_calls: toolCalls,
            },
            finish_reason: 'tool_calls',
          }],
        }
        sawAnswerFinish = true
        sawUpstreamCompletion = true
        if (this.onEnd && this.chatId) {
          this.onEnd(this.chatId)
        }
        resolveOnce(response)
        return true
      }

      const rejectOnce = (reason: any) => {
        if (!resolved) {
          resolved = true
          cleanup()
          const error = normalizeQwenAiStreamFailure(reason)
          destroyReadableStream(stream, error)
          reject(error)
        }
      }

      const finishNonStream = () => {
        if (resolved) return

        const choice = data.choices[0]
        const answerText = choice.message.content || ''
        const finalReasoning = reasoningText || summaryText
        const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
        if (incompleteDeclaredNativeToolNames.length > 0) {
          rejectOnce(createQwenAiIncompleteNativeToolError(incompleteDeclaredNativeToolNames))
          return
        }

        if (finishNativeToolCalls()) return

        const undeclaredNativeToolNames = this.getUndeclaredNativeToolNames()
        if (undeclaredNativeToolNames.length > 0 && !answerText.trim()) {
          rejectOnce(createQwenAiUndeclaredNativeToolError(undeclaredNativeToolNames))
          return
        }

        if (!answerText.trim() && !finalReasoning.trim()) {
          rejectOnce(createQwenAiStreamFailure(
            'Qwen AI returned an empty response stream without answer or reasoning content',
            'qwen_ai_empty_stream',
          ))
          return
        }

        const response = {
          ...data,
          choices: [{
            ...choice,
            message: {
              ...choice.message,
              ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
            },
          }],
        }
        if (!sawAnswerFinish) {
          console.log('[QwenAI] Non-stream completed with an upstream DONE signal.')
        }
        if (this.onEnd && this.chatId) {
          this.onEnd(this.chatId)
        }
        resolveOnce(response)
      }

      const handleIdle = async () => {
        if (resolved || idleRecoveryInFlight) return
        idleTimer = undefined
        const idleError = new Error(
          `Qwen AI response stream was idle for more than ${Math.ceil((options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS) / 1000)}s.`,
        )

        if (!options.recoverFromIdle) {
          rejectOnce(idleError)
          return
        }

        idleRecoveryInFlight = true
        try {
          const recovered = await options.recoverFromIdle(idleError)
          if (recovered) {
            if (!resolved) refreshIdleTimer()
            return
          }
          if (!resolved) rejectOnce(idleError)
        } catch (error) {
          if (!resolved) rejectOnce(error instanceof Error ? error : idleError)
        } finally {
          idleRecoveryInFlight = false
        }
      }

      const refreshIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        idleTimer = setTimeout(() => {
          void handleIdle()
        }, options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS)
      }

      function onAbort() {
        rejectOnce(new Error('Qwen AI response stream aborted because the client disconnected.'))
      }

      if (options.signal?.aborted) {
        rejectOnce(new Error('Qwen AI response stream aborted before reading started.'))
        return
      }

      if (responseTimeoutMs > 0) {
        responseTimer = setTimeout(() => {
          rejectOnce(new Error(`Qwen AI response stream timed out after ${Math.ceil(responseTimeoutMs / 1000)}s.`))
        }, responseTimeoutMs)
      }
      refreshIdleTimer()

      options.signal?.addEventListener('abort', onAbort, { once: true })

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            if (resolved) {
              return
            }

            if (typeof event.data !== 'string' || event.data.trim() === '') {
              return
            }

            if (event.data === '[DONE]') {
              refreshIdleTimer()
              sawUpstreamCompletion = true
              finishNonStream()
              return
            }

            let parsed: any
            try {
              parsed = JSON.parse(event.data)
            } catch (parseError) {
              const envelopeError = createQwenAiStreamEnvelopeError(event.data, event.data, event.event)
              if (envelopeError) {
                rejectOnce(envelopeError)
                return
              }
              throw parseError
            }
            const envelopeError = createQwenAiStreamEnvelopeError(parsed, event.data, event.event)
            if (envelopeError) {
              rejectOnce(envelopeError)
              return
            }

            if (parsed['response.created']) {
              this.recordResponseCreated(parsed['response.created'])
              if (this.responseId) {
                data.id = this.responseId
              }
            }

            if (parsed.choices && parsed.choices.length > 0) {
              if (!this.shouldProcessResponseEvent(parsed)) {
                return
              }
              if (this.responseId) {
                data.id = this.responseId
              }

              const delta = parsed.choices[0].delta || {}
              const phase = delta.phase
              const status = delta.status
              const content = delta.content || ''

              const previousSummaryLength = summaryText.length
              const nativeToolProgress = this.ingestNativeToolCallFragments(delta)
              if (isMeaningfulQwenAiEvent(event, previousSummaryLength) || nativeToolProgress.declaredProgress) {
                refreshIdleTimer()
              }

              if (phase === 'think' && status !== 'finished') {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                // Handle thinking_summary phase - extract summary content
                const extra = delta.extra || {}
                if (extra.summary_thought?.content) {
                  const newSummary = extra.summary_thought.content.join('\n')
                  if (newSummary && newSummary.length > summaryText.length) {
                    summaryText = newSummary
                  }
                }
              } else if (phase === 'answer') {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  sawAnswerFinish = true
                  sawUpstreamCompletion = true
                  finishNonStream()
                }
              } else if (phase === null) {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  sawAnswerFinish = true
                  sawUpstreamCompletion = true
                  finishNonStream()
                }
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', describeErrorForLog(err))
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => {
        parser.feed(buffer.toString())
      })
      stream.once('error', (err: Error) => {
        if (resolved) {
          return
        }
        const description = describeErrorForLog(err)
        if (isClientCancellationError(err)) {
          console.log('[QwenAI] Non-stream cancelled:', description)
        } else {
          console.error('[QwenAI] Non-stream error:', description)
        }
        rejectOnce(err)
      })
      const finishFromClose = () => {
        if (resolved) return
        if (!sawUpstreamCompletion) {
          rejectOnce(createQwenAiStreamFailure('Qwen AI response stream closed before an upstream completion signal'))
          return
        }
        finishNonStream()
      }
      stream.once('end', finishFromClose)
      stream.once('close', finishFromClose)
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }

  isComplete(): boolean {
    return this.streamCompleted
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
