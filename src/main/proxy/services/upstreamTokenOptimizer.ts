import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatMessageContent,
} from '../types.ts'
import { computeLiveZone } from './liveZone.ts'
import type { LiveZoneFloorSource } from './liveZone.ts'
import type { CompressionArchive } from './compressionArchive.ts'
import { resolveCompressionBackend, getCompressionSettings } from './compressionSettings.ts'
import type { CompressionBackendMode } from './backends/registry.ts'
import { tsBackend } from './backends/tsBackend.ts'
import type {
  BlockKind,
  CompactBlockResult,
  CompressionBackend,
  CompressionBackendId,
} from './backends/types.ts'

/**
 * Opt-in upstream token optimization.
 *
 * `safe` mode deliberately does not summarize, classify, or delete a whole
 * message. It only performs deterministic, information-preserving rewrites of
 * old tool text:
 *   - valid JSON is minified without changing its parsed value;
 *   - a run of >= 3 identical, non-critical lines is represented as one line
 *     plus an explicit repeat-count marker.
 *
 * `balanced` is an explicit experimental opt-in for older tool results: it
 * keeps head/tail, critical, and active-query-matching lines and replaces the
 * remainder with an omission marker. It is deliberately not the default.
 * System messages, recent messages, tool-call arguments, error results, and
 * unresolved/orphan tool calls remain untouched in every mode. In `safe`
 * mode, non-blank source code and markup are also left alone; only redundant
 * blank-line runs may be represented compactly. All modes are off by default
 * because a deterministic rewrite is not a substitute for a task-level
 * quality evaluation.
 */
export type UpstreamTokenOptimizerMode = 'off' | 'dry-run' | 'safe' | 'balanced'

export interface UpstreamTokenOptimizerSettings {
  mode: UpstreamTokenOptimizerMode
  minEstimatedTokens: number
  recentMessages: number
  minEstimatedSavings: number
  /** Maximum characters retained from one old tool result in balanced mode. */
  maxToolTextChars: number
  /**
   * Messages below this index are treated as the provider's frozen cacheable
   * prefix and are never rewritten. Zero derives the floor from `cache_control`
   * breakpoints instead, and falls back to zero when the client sends none.
   */
  frozenPrefixMessages?: number
}

export type LiveZoneFloorSource = 'cache-control' | 'frozen-prefix' | 'recent-window'

export interface UpstreamTokenOptimizerResult {
  request: ChatCompletionRequest
  mode: UpstreamTokenOptimizerMode
  applied: boolean
  estimatedInputTokensBefore: number
  estimatedInputTokensCandidate: number
  estimatedInputTokensAfter: number
  estimatedTokensSaved: number
  candidateTokensSaved: number
  changedMessageCount: number
  compactedJsonMessageCount: number
  compressedRunCount: number
  balancedMessageCount: number
  balancedOmittedChars: number
  /** Which rule produced the live-zone floor, for operator diagnosis. */
  liveZoneSource?: LiveZoneFloorSource
  liveZoneFloor?: number
  liveZoneCeiling?: number
  /**
   * How many balanced-mode omissions were written to the CCR archive, and how
   * many characters went in. Counts only: a hash identifies tool output that may
   * contain credentials or file contents, and this object reaches the log.
   */
  archivedCount: number
  archivedChars: number
  /** Which compute backend produced any rewrite. */
  backend: CompressionBackendId
  skipReason?: string
}

/**
 * Optional recoverable-compression wiring.
 *
 * The archive is an enhancement, never a dependency. Omitting it, or passing a
 * store that throws, still produces the token saving; only the retrieval key is
 * lost.
 */
export interface CompressionContext {
  archive?: CompressionArchive
  /** `providerId:accountId:conversationKey`. */
  scope?: string
  /**
   * Compute backend. Omit to use `context.backendMode` resolved through the
   * registry. An explicit backend wins, which is what the tests inject.
   */
  backend?: CompressionBackend
  /** `CHAT2API_COMPRESS_BACKEND`, default `ts`. */
  backendMode?: CompressionBackendMode
}

const DEFAULT_MIN_ESTIMATED_TOKENS = 20_000
const DEFAULT_RECENT_MESSAGES = 8
const DEFAULT_MIN_ESTIMATED_SAVINGS = 64
const DEFAULT_MAX_TOOL_TEXT_CHARS = 16_000
const DEFAULT_FROZEN_PREFIX_MESSAGES = 0
const REPEATED_LINE_MARKER_PREFIX = '[Chat2API repeated identical line x'
// --- moved to services/backends/tsBackend.ts ---


function collectToolCallState(messages: ChatMessage[]): {
  declared: Set<string>
  unresolved: Set<string>
} {
  const declared = new Set<string>()
  const resolved = new Set<string>()
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      if (typeof call.id === 'string' && call.id) declared.add(call.id)
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
      resolved.add(message.tool_call_id)
    }
  }
  return {
    declared,
    unresolved: new Set(Array.from(declared).filter(id => !resolved.has(id))),
  }
}

function hasErrorResult(content: ChatMessage['content']): boolean {
  if (!Array.isArray(content)) return false
  return content.some(part => {
    if (!part || typeof part !== 'object') return false
    const value = part as unknown as Record<string, unknown>
    return value.is_error === true || value.isError === true
  })
}

function isOldToolMessage(
  message: ChatMessage,
  declaredToolCallIds: Set<string>,
  unresolvedToolCallIds: Set<string>,
): boolean {
  if (message.role !== 'tool' || message.is_error === true || hasErrorResult(message.content)) return false
  if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
    // An orphan result has no safe lifecycle anchor. Keep it untouched rather
    // than guessing that it belongs to an old completed workflow.
    if (
      !declaredToolCallIds.has(message.tool_call_id)
      || unresolvedToolCallIds.has(message.tool_call_id)
    ) return false
  }
  return true
}


function parseNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function parseMode(raw: string | undefined): UpstreamTokenOptimizerMode {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value || ['0', 'false', 'off', 'disabled', 'no'].includes(value)) {
    return 'off'
  }
  if (['dry-run', 'dryrun', 'measure', 'diagnostic'].includes(value)) {
    return 'dry-run'
  }
  if (['1', 'true', 'on', 'yes', 'safe', 'structured'].includes(value)) {
    return 'safe'
  }
  if (['balanced', 'aggressive', 'pace', 'pace-lite'].includes(value)) {
    return 'balanced'
  }
  return 'off'
}

export function getUpstreamTokenOptimizerSettings(
  env: Record<string, string | undefined> = process.env,
): UpstreamTokenOptimizerSettings {
  return {
    mode: parseMode(env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER),
    minEstimatedTokens: parseNonNegativeInteger(
      env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS,
      DEFAULT_MIN_ESTIMATED_TOKENS,
    ),
    recentMessages: parseNonNegativeInteger(
      env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES,
      DEFAULT_RECENT_MESSAGES,
    ),
    minEstimatedSavings: parseNonNegativeInteger(
      env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_SAVINGS,
      DEFAULT_MIN_ESTIMATED_SAVINGS,
    ),
    maxToolTextChars: parseNonNegativeInteger(
      env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MAX_TOOL_TEXT_CHARS,
      DEFAULT_MAX_TOOL_TEXT_CHARS,
    ),
    frozenPrefixMessages: parseNonNegativeInteger(
      env.CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_FROZEN_PREFIX_MESSAGES,
      DEFAULT_FROZEN_PREFIX_MESSAGES,
    ),
  }
}

function estimateTextTokens(value: string | undefined | null): number {
  if (!value) return 0
  let asciiChars = 0
  let nonAsciiCodePoints = 0
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) || 0) <= 0x7f) asciiChars += 1
    else nonAsciiCodePoints += 1
  }
  return Math.ceil(asciiChars / 3) + nonAsciiCodePoints
}

function estimateStructuredTokens(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? estimateTextTokens(serialized) : 0
  } catch {
    return 0
  }
}

function estimateContentTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (!Array.isArray(content)) return 0
  return content.reduce((total, part) => {
    let partTokens = estimateTextTokens(part.type)
    if (part.type === 'text' && part.text) {
      partTokens += estimateTextTokens(part.text)
    }
    if (part.type === 'image_url') {
      partTokens += estimateTextTokens(part.image_url?.url)
      partTokens += estimateTextTokens(part.image_url?.detail)
    } else if (part.type === 'file') {
      partTokens += estimateTextTokens(part.file_url?.url)
    } else if (part.type === 'video_url') {
      partTokens += estimateTextTokens(part.video_url?.url)
    } else if (part.type === 'input_audio') {
      partTokens += part.input_audio?.data ? 22 : 0
      partTokens += estimateTextTokens(part.input_audio?.format)
    }
    partTokens += estimateTextTokens(part.filename)
    partTokens += estimateTextTokens(part.mime_type)
    partTokens += estimateTextTokens(part.local_path)
    return total + partTokens
  }, 0)
}

function estimateMessageTokens(message: ChatMessage): number {
  let tokens = estimateTextTokens(message.role)
    + estimateTextTokens(message.name)
    + estimateTextTokens(message.tool_call_id)
    + estimateContentTokens(message.content)
  if (message.tool_calls?.length) {
    tokens += estimateStructuredTokens(message.tool_calls)
  }
  return tokens
}

export function estimateUpstreamRequestTokens(
  request: ChatCompletionRequest,
): number {
  const messageTokens = request.messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  )
  return Math.max(1, messageTokens + (request.tools?.length
    ? estimateStructuredTokens(request.tools)
    : 0))
}

// --- moved to services/backends/tsBackend.ts ---
function extractActiveUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || message.tool_call_id) continue
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('\n')
    if (text) return text
  }
  return ''
}

// --- moved to services/backends/tsBackend.ts ---
function balancedOmittedMarker(omittedChars: number, omittedLines: number): string {
  return `[Chat2API omitted tool output: ${omittedChars} chars / ${omittedLines} lines; critical and query lines retained]`
}

/**
 * The same omission, but addressable. Emitted only when the CCR archive
 * accepted the dropped text; otherwise the plain marker stands, because a
 * retrieval key the store cannot resolve is worse than no key at all.
 */
function balancedArchiveMarker(hash: string, omittedChars: number, omittedLines: number): string {
  return `[Chat2API archive:tool:${hash} ${omittedChars} chars / ${omittedLines} lines omitted; `
    + `call retrieve_tool_output with this hash to expand]`
}

const OMISSION_MARKER_PATTERN = /\[Chat2API omitted tool output: [^\]]*\]/g

/** Hand the dropped lines to the archive. Any failure degrades to no archive. */
function archiveOmission(
  _content: string | ChatMessageContent[],
  omittedLinesText: string[],
  context: CompressionContext,
): { hash: string; chars: number } | undefined {
  const archive = context.archive
  const scope = context.scope
  if (!archive || !scope) return undefined

  const omitted = omittedLinesText.join('\n')
  if (omitted.length === 0) return undefined

  try {
    const hash = archive.record(scope, omitted)
    if (!hash) return undefined
    return { hash, chars: omitted.length }
  } catch {
    // Compression is an optimization, never a request dependency. A store that
    // throws must not fail the request that happened to trigger a write.
    return undefined
  }
}

/**
 * Point every plain omission marker at the archived hash.
 *
 * One archive entry covers the whole message, and a message can hold several
 * gaps, so every marker in it is rewritten to the same hash. Retrieval returns
 * the dropped lines; the lines still inline are not duplicated there.
 */
function replaceOmissionMarkers(
  content: string | ChatMessageContent[],
  omittedChars: number,
  archived: { hash: string; chars: number },
): string | ChatMessageContent[] {
  const rewrite = (text: string): string => {
    if (!text.includes('[Chat2API omitted tool output:')) return text
    return text.replace(
      OMISSION_MARKER_PATTERN,
      balancedArchiveMarker(archived.hash, omittedChars, 0),
    )
  }

  if (typeof content === 'string') return rewrite(content)
  if (!Array.isArray(content)) return content
  return content.map((part) => (
    part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: rewrite(part.text) }
      : part
  ))
}

// --- compactBalancedText moved to services/backends/tsBackend.ts ---

type MessageCompactionResult = {
  content: string | ChatMessageContent[]
  compactedJson: boolean
  compressedRunCount: number
  balanced: boolean
  omittedChars: number
  /** Only populated in balanced mode, and only when something was dropped. */
  omittedLinesText: string[]
  /** Which backend produced this rewrite. */
  backend: CompressionBackendId
}

/**
 * Hand one text block to the backend and wrap the answer back into a message.
 *
 * This is the only place a backend is consulted, and it is deliberately thin:
 * eligibility was already decided by the live zone, protection was already
 * applied, and a backend that declines, throws, or returns a longer string
 * simply produces no change. Every judgment stays in this file.
 */
async function compactMessageContent(
  message: ChatMessage,
  options: {
    mode: UpstreamTokenOptimizerMode
    maxToolTextChars: number
    activeQuery: string
    backend: CompressionBackend
  },
): Promise<MessageCompactionResult | undefined> {
  const { mode, maxToolTextChars, activeQuery, backend } = options

  const rewriteOne = async (text: string): Promise<CompactBlockResult | undefined> => {
    try {
      const result = await backend.compact(text, {
        kind: classifyBlockKind(text),
        mode: mode === 'balanced' ? 'balanced' : 'safe',
        maxChars: maxToolTextChars,
        activeQuery,
        protectedLines: [],
      })
      // A rewrite that is not strictly shorter is a bug or a no-op. Discard it
      // rather than growing the request.
      if (!result || typeof result.text !== 'string') return undefined
      if (result.text.length >= text.length) return undefined
      return result
    } catch {
      // Compression is an optimization, never a request dependency.
      return undefined
    }
  }

  if (typeof message.content === 'string') {
    const result = await rewriteOne(message.content)
    if (!result) return undefined
    return {
      content: result.text,
      compactedJson: result.compactedJson ?? false,
      compressedRunCount: result.compressedRunCount ?? 0,
      balanced: result.omittedChars > 0,
      omittedChars: result.omittedChars,
      omittedLinesText: result.omittedLinesText ?? [],
      backend: result.backend,
    }
  }
  if (!Array.isArray(message.content)) return undefined

  let compactedJson = false
  let compressedRunCount = 0
  let balanced = false
  let omittedChars = 0
  const omittedLinesText: string[] = []
  let backendId: CompressionBackendId = backend.id
  let changed = false

  const parts: ChatMessageContent[] = []
  for (const part of message.content) {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      parts.push(part)
      continue
    }
    const result = await rewriteOne(part.text)
    if (!result) {
      parts.push(part)
      continue
    }
    changed = true
    compactedJson ||= result.compactedJson ?? false
    compressedRunCount += result.compressedRunCount ?? 0
    balanced ||= result.omittedChars > 0
    omittedChars += result.omittedChars
    omittedLinesText.push(...(result.omittedLinesText ?? []))
    backendId = result.backend
    parts.push({ ...part, text: result.text })
  }

  if (!changed) return undefined
  return {
    content: parts,
    compactedJson,
    compressedRunCount,
    balanced,
    omittedChars,
    omittedLinesText,
    backend: backendId,
  }
}

/**
 * A coarse content hint for the backend. Backends may ignore it; the decision
 * layer never branches on it, because misclassifying must not change what is
 * eligible, only what a backend chooses to do with it.
 */
function classifyBlockKind(text: string): BlockKind {
  const trimmed = text.trimStart()[0]
  if (trimmed === '[' || trimmed === '{') return 'json'
  if (looksLikeLogLine(text)) return 'log'
  if (/```|^\s*(?:def |class |function |import |const |let )/m.test(text)) return 'code'
  return 'text'
}

function looksLikeLogLine(text: string): boolean {
  const sample = text.split('\n', 8)
  const dated = sample.filter((line) => /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(line)).length
  return dated > 0 && dated >= Math.min(2, sample.length)
}



function applyCandidate(
  request: ChatCompletionRequest,
  messages: ChatMessage[],
): ChatCompletionRequest {
  if (messages.every((message, index) => message === request.messages[index])) {
    return request
  }
  return { ...request, messages }
}

function unchangedResult(
  request: ChatCompletionRequest,
  settings: UpstreamTokenOptimizerSettings,
  estimatedInputTokensBefore: number,
  skipReason: string,
): UpstreamTokenOptimizerResult {
  return {
    request,
    mode: settings.mode,
    applied: false,
    estimatedInputTokensBefore,
    estimatedInputTokensCandidate: estimatedInputTokensBefore,
    estimatedInputTokensAfter: estimatedInputTokensBefore,
    estimatedTokensSaved: 0,
    candidateTokensSaved: 0,
    changedMessageCount: 0,
    compactedJsonMessageCount: 0,
    compressedRunCount: 0,
    balancedMessageCount: 0,
    balancedOmittedChars: 0,
    archivedCount: 0,
    archivedChars: 0,
    backend: 'ts' as CompressionBackendId,
    skipReason,
  }
}

/**
 * Build a candidate request without mutating the input request.
 *
 * `dry-run` reports the candidate savings but returns the original request.
 * `safe` applies the candidate only when it saves at least the configured
 * minimum. `off` is a no-op.
 */
export async function optimizeUpstreamRequest(
  request: ChatCompletionRequest,
  settings: UpstreamTokenOptimizerSettings = getUpstreamTokenOptimizerSettings(),
  context: CompressionContext = {},
): Promise<UpstreamTokenOptimizerResult> {
  const estimatedInputTokensBefore = estimateUpstreamRequestTokens(request)
  if (settings.mode === 'off') {
    return unchangedResult(request, settings, estimatedInputTokensBefore, 'disabled')
  }
  if (estimatedInputTokensBefore < settings.minEstimatedTokens) {
    return unchangedResult(request, settings, estimatedInputTokensBefore, 'below_min_estimated_tokens')
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return unchangedResult(request, settings, estimatedInputTokensBefore, 'no_messages')
  }

  // The pre-Phase-1 rule was `cutoff = max(0, length - recentMessages)` with
  // eligibility `index < cutoff`. It was position-blind in a way that mattered:
  // `collectToolCallState` only knows whether an id has a result SOMEWHERE in
  // the request, so with `recentMessages=1` the newest tool result — the one
  // the model is about to act on — was eligible and `balanced` rewrote it.
  // The live zone fixes that and additionally takes the floor from the
  // provider's prompt-cache boundary when the client declares one.
  const liveZone = computeLiveZone(request.messages, {
    frozenPrefixMessages: Number.isSafeInteger(settings.frozenPrefixMessages)
      && (settings.frozenPrefixMessages as number) > 0
      ? (settings.frozenPrefixMessages as number)
      : DEFAULT_FROZEN_PREFIX_MESSAGES,
    recentMessages: settings.recentMessages,
  })
  const maxToolTextChars = Number.isSafeInteger(settings.maxToolTextChars)
    && settings.maxToolTextChars > 0
    ? settings.maxToolTextChars
    : DEFAULT_MAX_TOOL_TEXT_CHARS
  const toolCallState = collectToolCallState(request.messages)

  // `ts` is the guaranteed floor, so a registry failure cannot leave us without
  // a backend, and the call itself never rejects. The mode comes from the
  // shared settings module so the documented default and the effective one cannot
  // drift apart.
  const backend = context.backend ?? await resolveCompressionBackend(getCompressionSettings().mode)

  const candidateMessages: ChatMessage[] = []
  let changedMessageCount = 0
  let compactedJsonMessageCount = 0
  let compressedRunCount = 0
  let balancedMessageCount = 0
  let balancedOmittedChars = 0
  let archivedCount = 0
  let archivedChars = 0
  let backendId: CompressionBackendId = backend.id
  const activeQuery = extractActiveUserText(request.messages).slice(0, 10_000)

  for (const [index, message] of request.messages.entries()) {
    const eligible = liveZone.isEligible(message, index)
      && isOldToolMessage(message, toolCallState.declared, toolCallState.unresolved)
    if (!eligible) {
      candidateMessages.push(message)
      continue
    }

    const compacted = await compactMessageContent(message, {
      mode: settings.mode,
      maxToolTextChars: maxToolTextChars,
      activeQuery,
      backend,
    })
    if (!compacted) {
      candidateMessages.push(message)
      continue
    }

    // CCR: in balanced mode the dropped text is archived and the marker becomes
    // addressable. Safe mode is information-preserving, so it archives nothing;
    // there is nothing to retrieve.
    let content = compacted.content
    if (compacted.balanced && compacted.omittedLinesText.length > 0) {
      const archived = archiveOmission(content, compacted.omittedLinesText, context)
      if (archived) {
        content = replaceOmissionMarkers(content, compacted.omittedChars, archived)
        archivedCount += 1
        archivedChars += archived.chars
      }
    }

    const candidateMessage: ChatMessage = {
      ...message,
      content,
    }
    candidateMessages.push(candidateMessage)
    changedMessageCount += 1
    if (compacted.compactedJson) compactedJsonMessageCount += 1
    if (compacted.balanced) balancedMessageCount += 1
    balancedOmittedChars += compacted.omittedChars
    compressedRunCount += compacted.compressedRunCount
    backendId = compacted.backend
  }

  const candidateRequest = applyCandidate(request, candidateMessages)
  const estimatedInputTokensCandidate = estimateUpstreamRequestTokens(candidateRequest)
  const candidateTokensSaved = estimatedInputTokensBefore - estimatedInputTokensCandidate
  const liveZoneReport = {
    liveZoneSource: liveZone.source,
    liveZoneFloor: liveZone.floor,
    liveZoneCeiling: liveZone.ceiling,
  }
  if (candidateTokensSaved < settings.minEstimatedSavings || changedMessageCount === 0) {
    return {
      ...unchangedResult(request, settings, estimatedInputTokensBefore, 'insufficient_savings'),
      ...liveZoneReport,
      estimatedInputTokensCandidate,
      candidateTokensSaved,
      changedMessageCount,
      compactedJsonMessageCount,
      compressedRunCount,
      balancedMessageCount,
      balancedOmittedChars,
      archivedCount,
      archivedChars,
      backend: backendId,
    }
  }

  if (settings.mode === 'dry-run') {
    return {
      request,
      mode: settings.mode,
      applied: false,
      ...liveZoneReport,
      estimatedInputTokensBefore,
      estimatedInputTokensCandidate,
      estimatedInputTokensAfter: estimatedInputTokensBefore,
      estimatedTokensSaved: 0,
      candidateTokensSaved,
      changedMessageCount,
      compactedJsonMessageCount,
      compressedRunCount,
      balancedMessageCount,
      balancedOmittedChars,
      archivedCount,
      archivedChars,
      backend: backendId,
      skipReason: 'dry_run',
    }
  }

  return {
    request: candidateRequest,
    mode: settings.mode,
    applied: true,
    ...liveZoneReport,
    estimatedInputTokensBefore,
    estimatedInputTokensCandidate,
    estimatedInputTokensAfter: estimatedInputTokensCandidate,
    estimatedTokensSaved: candidateTokensSaved,
    candidateTokensSaved,
    changedMessageCount,
    compactedJsonMessageCount,
    compressedRunCount,
    balancedMessageCount,
    balancedOmittedChars,
    archivedCount,
    archivedChars,
    backend: backendId,
  }
}
