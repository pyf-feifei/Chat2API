/**
 * The proxy-internal tool loop — Task 2.3b, phase A.
 *
 * Wraps a single upstream attempt. When the response contains calls to a
 * proxy-internal tool, the call is resolved locally, the resolved result is
 * appended to the transcript, and the attempt is repeated with the expanded
 * context. The model therefore reasons over what it retrieved, and the client
 * only ever sees the final response.
 *
 * ## Scope of phase A
 *
 * Non-streaming only. A streaming attempt has already committed `role:
 * assistant` to the client by the time a tool call is parsed, so continuing it
 * would either show the client two assistant turns or require buffering the
 * whole first turn. Neither is decided here. When this sees a streaming
 * request it simply does not arm the context, so the model is never taught the
 * tool and never asks.
 *
 * Phases B (Qwen sticky continuation) and C (general streaming) build on the
 * same partition; they do not change it.
 */

import { buildRetrievalContinuation, runWithLocalToolContext, type LocalToolContext } from '../toolCalling/localToolCalls.ts'
import type { LocalToolCallRecord } from '../toolCalling/types.ts'
import type { ChatCompletionRequest, ChatMessage } from '../types.ts'

export interface RetrievalLoopInput {
  /** Runs one upstream attempt. */
  attempt: (request: ChatCompletionRequest) => Promise<any>
  /** The request as the client sent it. */
  request: ChatCompletionRequest
  /** The context the attempt must see. */
  context: LocalToolContext
  /** The transformed request, which carries the prompt-injected tool contract. */
  baseRequest: ChatCompletionRequest
  signal?: AbortSignal
}

export interface RetrievalLoopResult<T = any> {
  response: T
  /** Continuation turns executed, for the log line. */
  turns: number
  /** Resolved calls, in order. */
  resolved: LocalToolCallRecord[]
  /** Why the loop stopped, when it stopped early. */
  stopReason?: 'budget-exhausted' | 'client-aborted' | 'no-local-calls'
}

export async function runWithRetrievalLoop<T = any>(
  input: RetrievalLoopInput,
): Promise<RetrievalLoopResult<T>> {
  const { attempt, request, context, baseRequest, signal } = input
  const budget = context.settings.maxRetrievalsPerRequest

  // A streaming request is out of scope for phase A. Do not arm the context at
  // all: without it the partition is a pass-through and the model is never
  // taught the tool, so it cannot ask.
  if (request.stream) {
    const response = await runWithLocalToolContext(context, () => attempt(baseRequest))
    return { response, turns: 0, resolved: [], stopReason: 'no-local-calls' }
  }

  return runWithLocalToolContext(context, async () => {
    let currentRequest = baseRequest
    const resolved: LocalToolCallRecord[] = []
    let turns = 0
    let response = await attempt(currentRequest)

    for (;;) {
      const local = context.pending
      context.pending = []
      if (local.length === 0) {
        return { response, turns, resolved, stopReason: 'no-local-calls' as const }
      }
      if (context.used >= budget) {
        // The model is looping on retrieval. The budget already told it to stop
        // in the tool result; return what we have rather than spend the context
        // window re-expanding spans.
        return { response, turns, resolved, stopReason: 'budget-exhausted' as const }
      }
      if (signal?.aborted) {
        return { response, turns, resolved, stopReason: 'client-aborted' as const }
      }

      const assistantMessage = extractAssistantMessage(response)
      if (!assistantMessage) {
        return { response, turns, resolved, stopReason: 'no-local-calls' as const }
      }

      const continuation = buildRetrievalContinuation({
        messages: currentRequest.messages as ChatMessage[],
        assistantMessage,
        local,
      })
      if (!continuation) {
        return { response, turns, resolved, stopReason: 'no-local-calls' as const }
      }

      resolved.push(...local)
      currentRequest = { ...baseRequest, messages: continuation }
      turns += 1
      response = await attempt(currentRequest)
    }
  })
}

function extractAssistantMessage(response: any): ChatMessage | undefined {
  const message = response?.choices?.[0]?.message
  if (!message || typeof message !== 'object') return undefined
  return message as ChatMessage
}
