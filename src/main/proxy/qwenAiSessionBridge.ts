import { createHash } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage } from './types'

/**
 * Idempotent append ticket for sticky mode. When a client retries a request
 * whose delta was already appended to the upstream chat, the proxy must not
 * append the user message a second time — it re-attaches to the in-flight or
 * completed generation instead.
 */
export interface QwenAiStickyAppendedTurn {
  /** The Responses previous_response_id this delta was appended under. */
  prevResponseId: string
  /** sha256 of the canonicalized delta messages appended to the chat. */
  deltaHash: string
  /** The user-message fid generated when the delta was appended. */
  userFid?: string
  /** 'appending' = accepted by upstream, stream not yet finished. */
  state: 'appending' | 'done'
}

/**
 * Provider state retained for one Responses API conversation edge. The values
 * are deliberately opaque to callers: they are valid only for the account
 * that created the Qwen chat.
 */
export interface QwenAiSessionBinding {
  providerId: string
  accountId: string
  requestedModel: string
  actualModel: string
  chatId: string
  parentId: string
  requestFingerprint: string
  toolProtocol?: string
  /** Sticky mode: root response id of the lineage this chat serves. */
  lineageKey?: string
  /** Sticky mode: sha256 over the canonicalized stored transcript prefix. */
  transcriptHash?: string
  /** Sticky mode: number of turns appended to this chat so far. */
  turnCount?: number
  /** Sticky mode: rough cumulative byte estimate of the upstream chat. */
  approxBytes?: number
  /** Sticky mode: ticket for the most recently appended turn. */
  appendedTurn?: QwenAiStickyAppendedTurn
}

/** Per-request bridge information passed from the Responses route to Qwen. */
export interface QwenAiSessionBridge {
  requestFingerprint: string
  continuation?: {
    binding: QwenAiSessionBinding
    inputMessages: ChatMessage[]
    /**
     * Sticky mode: the delta was already appended upstream on a prior attempt
     * of this same request. The forwarder must resume the in-flight/completed
     * generation rather than append the user message again.
     */
    resumeOnly?: boolean
  }
  /**
   * Sticky mode: delta hash for the turn about to be appended, so the
   * forwarder can write the idempotent-append ticket back into the stored
   * binding after the continuation is accepted.
   */
  stickyDeltaHash?: string
}

/**
 * A live state source is kept only until the outgoing response completes.
 * Stream handlers learn the real parent response ID asynchronously, so it
 * must be read when the Responses conversation entry is committed.
 */
export interface QwenAiSessionState {
  providerId: string
  accountId: string
  requestedModel: string
  actualModel: string
  requestFingerprint: string
  toolProtocol?: string
  getChatId: () => string
  getParentId: () => string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value)
      ? String(value)
      : value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const child = record[key]
      if (child !== undefined) result[key] = canonicalize(child)
      return result
    }, {})
}

function leadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const message of messages) {
    if (message.role !== 'system') break
    result.push(message)
  }
  return result
}

/**
 * The first Qwen turn establishes both the managed tool catalog and the
 * system-level behavior. A continuation is valid only when that contract is
 * unchanged; normal user/tool-result data intentionally stays out of this
 * fingerprint.
 */
export function createQwenAiSessionRequestFingerprint(
  request: Pick<
    ChatCompletionRequest,
    | 'model'
    | 'messages'
    | 'tools'
    | 'tool_choice'
    | 'parallel_tool_calls'
    | 'response_format'
    | 'reasoning_effort'
    | 'enable_thinking'
    | 'thinking_budget'
    | 'image_generation'
  >,
): string {
  const contract = canonicalize({
    model: request.model,
    tools: request.tools ?? [],
    tool_choice: request.tool_choice ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? null,
    response_format: request.response_format ?? null,
    reasoning_effort: request.reasoning_effort ?? null,
    enable_thinking: request.enable_thinking ?? null,
    thinking_budget: request.thinking_budget ?? null,
    image_generation: request.image_generation ?? null,
    system_messages: leadingSystemMessages(request.messages),
  })
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

/**
 * Hash the canonicalized transcript so a sticky continuation can verify the
 * client-sent history still matches what the proxy recorded. A mismatch means
 * the client rewrote or compacted history — the delta cannot be appended
 * without losing context, so the turn falls back to a full replay.
 */
export function createQwenAiTranscriptHash(messages: readonly ChatMessage[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(messages)))
    .digest('hex')
}

/** Hash the canonicalized delta messages for the idempotent append ticket. */
export function createQwenAiDeltaHash(messages: readonly ChatMessage[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(messages)))
    .digest('hex')
}

/**
 * Content fingerprint identifying a store:false conversation chain. The
 * instructions (system prompt) and the first K conversation messages are
 * stable across a codex task's turns — they form a natural session key that
 * does not require any client cooperation.
 */
export function createQwenAiChainKey(
  instructions: string | undefined,
  headMessages: readonly ChatMessage[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      instructions: instructions ?? null,
      head: canonicalize(headMessages),
    }))
    .digest('hex')
}

/** Number of leading messages used for chain identification. */
export function qwenAiStickyChainHeadFromEnv(): number {
  const raw = process.env.CHAT2API_QWEN_AI_STICKY_CHAIN_HEAD
  const parsed = raw === undefined ? 3 : Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 3
}

export function resolveQwenAiSessionBinding(
  state: QwenAiSessionState | undefined,
): QwenAiSessionBinding | undefined {
  if (!state) return undefined

  const chatId = state.getChatId().trim()
  const parentId = state.getParentId().trim()
  if (!chatId || !parentId) return undefined

  return {
    providerId: state.providerId,
    accountId: state.accountId,
    requestedModel: state.requestedModel,
    actualModel: state.actualModel,
    chatId,
    parentId,
    requestFingerprint: state.requestFingerprint,
    ...(state.toolProtocol ? { toolProtocol: state.toolProtocol } : {}),
  }
}
