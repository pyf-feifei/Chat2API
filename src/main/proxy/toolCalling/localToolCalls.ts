/**
 * Proxy-internal tool calls: partition, context, continuation.
 *
 * The managed tool system assumes every declared tool belongs to the client and
 * every parsed call reaches the client. `retrieve_tool_output` inverts that: the
 * model may call it, this process resolves it, and the client never sees it.
 * This module is the one place the two meet.
 *
 * ## Why AsyncLocalStorage
 *
 * The resolution context (archive, scope, advertised hashes, budget) has to
 * reach `partitionLocalToolCalls`, which is called deep inside a provider
 * forwarder, while also being readable by the loop that wraps the forward. The
 * obvious implementation is a module-level mutable singleton, and it is wrong:
 * the proxy serves requests concurrently, so a singleton leaks one request's
 * archive scope into another's retrieval.
 *
 * `AsyncLocalStorage` carries the context across the async call chain without a
 * global, which is exactly the problem it exists for. It has not been used in
 * this repository before, so the first use is deliberate rather than incidental.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isRetrievalToolName, resolveRetrievalCall } from '../services/retrievalTool.ts'
import type { CompressionArchive } from '../services/compressionArchive.ts'
import type { RetrievalSettings } from '../services/retrievalTool.ts'
import type { ChatMessage } from '../types.ts'
import type { LocalToolCallRecord, NormalizedToolCall, ToolCallingPlan } from './types.ts'

export interface LocalToolContext {
  /** `providerId:accountId:conversationKey`. */
  scope: string
  archive: CompressionArchive
  /** Hashes this request advertised, from the archive markers in its messages. */
  advertised: string[]
  settings: RetrievalSettings
  /** Calls resolved so far, across every continuation turn of this request. */
  used: number
  /** Recorded on the plan so the loop can see it. */
  pending: LocalToolCallRecord[]
}

const contextStore = new AsyncLocalStorage<LocalToolContext>()

/** Run `fn` with a retrieval context visible to the whole async subtree. */
export function runWithLocalToolContext<T>(
  context: LocalToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStore.run(context, fn)
}

/**
 * The active context, or undefined.
 *
 * Undefined is the normal case for any request that did not opt into
 * retrieval, and it must mean "no local tools" rather than "throw".
 */
export function getLocalToolContext(): LocalToolContext | undefined {
  return contextStore.getStore()
}

export interface LocalResolutionInput {
  plan: ToolCallingPlan
  toolCalls: NormalizedToolCall[]
}

export interface LocalResolutionOutput {
  /** Calls the client owns and must see. */
  clientCalls: NormalizedToolCall[]
  /** Calls resolved locally, to be sent back as a continuation. */
  local: LocalToolCallRecord[]
}

let idCounter = 0

function nextCallId(): string {
  idCounter += 1
  return `call_ccr_${Date.now().toString(36)}_${idCounter}`
}

/**
 * Partition a parsed response's calls into client-owned and proxy-internal.
 *
 * With no active context this is a pass-through, which is what keeps every
 * deployment that has not enabled retrieval on exactly today's behavior.
 */
export function partitionLocalToolCalls(input: LocalResolutionInput): LocalResolutionOutput {
  const { plan, toolCalls } = input
  const context = getLocalToolContext()

  const hasLocal = Boolean(context) && toolCalls.some((call) => isRetrievalToolName(call.name))
  if (!context || !hasLocal) {
    // No context, or nothing local: the existing id assignment applies unchanged.
    const prefix = nextCallId()
    return {
      clientCalls: toolCalls.map((call, index) => ({ ...call, id: `${prefix}_${index}` })),
      local: [],
    }
  }

  const clientCalls: NormalizedToolCall[] = []
  const local: LocalToolCallRecord[] = []

  for (const call of toolCalls) {
    const id = nextCallId()
    if (!isRetrievalToolName(call.name)) {
      clientCalls.push({ ...call, id })
      continue
    }

    const outcome = resolveRetrievalCall({
      call,
      archive: context.archive,
      scope: context.scope,
      advertised: context.advertised,
      retrievalsUsed: context.used + local.length,
      settings: context.settings,
    })
    if (!outcome.handled) {
      // Defensive and currently unreachable: `isRetrievalToolName` already
      // matched. Handing it to the client is the safe failure, because the
      // alternative is the call vanishing from a response the model produced.
      clientCalls.push({ ...call, id })
      continue
    }
    context.used += 1
    local.push({
      id,
      name: call.name,
      arguments: call.arguments,
      content: outcome.result.content,
      isError: outcome.result.isError === true,
    })
  }

  if (local.length > 0) {
    context.pending = local
    plan.localToolCalls = local
  }
  return { clientCalls, local }
}

export interface RetrievalContinuationInput {
  /** The transcript as sent upstream, WITHOUT the assistant turn just produced. */
  messages: readonly ChatMessage[]
  assistantMessage: ChatMessage
  local: readonly LocalToolCallRecord[]
}

/**
 * Build the continuation request.
 *
 * The assistant turn must carry the tool calls the model emitted, or the tool
 * results that follow have no declared call to attach to and a provider
 * rejects the pair. When the upstream turn already carries its own calls
 * (a real client tool in the same response) they are preserved as-is rather
 * than merged, because the upstream ids and the local ids are separate.
 */
export function buildRetrievalContinuation(
  input: RetrievalContinuationInput,
): ChatMessage[] | undefined {
  const { messages, assistantMessage, local } = input
  if (!Array.isArray(local) || local.length === 0) return undefined

  const assistantWithCalls: ChatMessage = assistantMessage.tool_calls?.length
    ? assistantMessage
    : {
        ...assistantMessage,
        tool_calls: local.map((entry) => ({
          id: entry.id,
          type: 'function',
          function: { name: entry.name, arguments: entry.arguments },
        })),
      }

  const results: ChatMessage[] = local.map((entry) => ({
    role: 'tool',
    tool_call_id: entry.id,
    content: entry.content,
    ...(entry.isError ? { is_error: true } : {}),
  } as ChatMessage))

  return [...messages, assistantWithCalls, ...results]
}

/** Test-only: reset the id counter so assertions are stable. */
export function resetLocalToolIdCounter(): void {
  idCounter = 0
}
