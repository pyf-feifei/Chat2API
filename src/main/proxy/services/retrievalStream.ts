/**
 * Streaming retrieval loop — Task 2.3b, phase C.
 *
 * ## The problem
 *
 * A streaming turn has already committed `role: assistant` to the client by the
 * time a tool call is parsed. A proxy-internal tool therefore has exactly two
 * options, and both cost something:
 *
 *   - emit the first turn and then a second one, so the client sees two
 *     assistant turns for a single request;
 *   - buffer the first turn, resolve, continue, and emit only the final one.
 *
 * This implements the second. The cost is a delayed first token, which is why
 * the stream is only wrapped when the request was *armed* for retrieval. An
 * unarmed request's stream object is returned by identity, so a deployment that
 * does not use the feature is byte-for-byte unaffected.
 *
 * ## Why a Proxy
 *
 * The chat route treats `result.stream` as a `QwenAiOutputStream` and reads
 * `qwenAiFailure`, `qwenAiEffectiveAccountId`, `qwenAiEffectiveProviderId`,
 * `qwenAiEffectiveActualModel`, `qwenAiSessionState` and `qwenAiToolCallIds`
 * off it. Copying a known list would silently break the day a property is added;
 * forwarding every read to the current underlying stream is future-proof.
 *
 * After a continuation the metadata must come from the NEW stream, because that
 * is the turn the client is actually receiving, so the proxy's target is
 * swappable rather than fixed.
 */

import { PassThrough } from 'node:stream'
import type { LocalToolCallRecord } from '../toolCalling/types.ts'
import type { ChatMessage } from '../types.ts'
import type { LocalToolContext } from '../toolCalling/localToolCalls.ts'

export interface RetrievalStreamInput {
  /** The upstream stream produced by the first turn. */
  source: PassThrough & Record<string, unknown>
  /**
   * The retrieval context for THIS request.
   *
   * Passed in rather than read from `AsyncLocalStorage`. A streaming forwarder
   * resolves as soon as the PassThrough exists, so the async-local context is
   * already gone by the time the stream's `end` fires; reading it there returned
   * undefined and the loop could never fire in production. The partition side is
   * unaffected because it runs while the context is still live.
   */
  context: LocalToolContext
  /**
   * Called when the first turn asked for something local. Returns the stream
   * for the continuation turn, or undefined to fall back to emitting the first
   * turn unchanged.
   */
  continue: (
    local: LocalToolCallRecord[],
    assistantMessage: ChatMessage,
  ) => Promise<(PassThrough & Record<string, unknown>) | undefined>
  /** Hard bound on continuation turns. */
  budget: number
  onLoop?: (info: { turns: number; resolved: number; reason: string }) => void
}

/** Cap the buffer so a runaway turn cannot exhaust memory. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

export function createRetrievalAwareStream(
  input: RetrievalStreamInput,
): PassThrough & Record<string, unknown> {
  const { source, context, continue: continueTurn, budget } = input

  const out = new PassThrough() as PassThrough & Record<string, unknown>
  // Swappable so post-continuation metadata reads hit the stream the client is
  // actually receiving.
  let current: Record<string, unknown> = source as unknown as Record<string, unknown>

  const chunks: Buffer[] = []
  let bufferedBytes = 0
  let turns = 0
  let resolved = 0
  let ended = false
  let failed = false

  const proxy = new Proxy(out, {
    get(target, property, receiver) {
      // A property the output stream itself owns wins: the route writes
      // `qwenAiFailure` back onto the stream it is reading.
      if (property in target) {
        const own = Reflect.get(target, property, receiver)
        return typeof own === 'function' ? own.bind(target) : own
      }
      const value = Reflect.get(current, property)
      return typeof value === 'function' ? value.bind(current) : value
    },
    has(target, property) {
      return property in target || property in current
    },
    set(target, property, value, receiver) {
      // A write from the consumer (the route stamping a failure) must land
      // somewhere the next read will see.
      if (property in current) {
        Reflect.set(current, property, value)
        return true
      }
      return Reflect.set(target, property, value, receiver)
    },
  }) as PassThrough & Record<string, unknown>

  const flushBuffered = (): void => {
    for (const chunk of chunks) out.write(chunk)
    chunks.length = 0
    bufferedBytes = 0
  }

  const finishWith = (stream: PassThrough & Record<string, unknown>): void => {
    current = stream as unknown as Record<string, unknown>
    stream.on('data', (chunk: Buffer | string) => out.write(chunk))
    stream.on('end', () => {
      input.onLoop?.({ turns, resolved, reason: 'continued' })
      out.end()
    })
    stream.on('error', (error: Error) => out.destroy(error))
  }

  const onEnd = (): void => {
    if (ended) return
    ended = true

    const local = context.pending ?? []
    context.pending = []

    if (local.length === 0 || failed || turns >= budget) {
      // Nothing local, a failure, or the budget is spent: emit what we have.
      // For an armed request this is a first-turn-only answer, which is exactly
      // what the client would have seen without the feature.
      flushBuffered()
      input.onLoop?.({
        turns,
        resolved,
        reason: local.length === 0 ? 'no-local-calls' : failed ? 'stream-failed' : 'budget-exhausted',
      })
      out.end()
      return
    }

    const assistantMessage = assistantMessageFromFrames(chunks)
    if (!assistantMessage) {
      flushBuffered()
      input.onLoop?.({ turns, resolved, reason: 'unparseable-first-turn' })
      out.end()
      return
    }

    turns += 1
    resolved += local.length
    continueTurn(local, assistantMessage)
      .then((next) => {
        if (!next) {
          flushBuffered()
          input.onLoop?.({ turns, resolved, reason: 'continuation-unavailable' })
          out.end()
          return
        }
        finishWith(next)
      })
      .catch((error: Error) => {
        // A failed continuation still owes the client the turn it already
        // paid for. Emit it rather than dropping the response.
        flushBuffered()
        input.onLoop?.({ turns, resolved, reason: 'continuation-failed' })
        out.end()
        if (error) console.warn('[RetrievalStream] continuation failed', error.message)
      })
  }

  source.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bufferedBytes += buffer.length
    if (bufferedBytes > MAX_BUFFERED_BYTES) {
      // Too large to hold. Emit what has accumulated and stop arming; the
      // client still gets a complete first turn.
      console.warn('[RetrievalStream] first turn exceeded the buffer cap; emitting without continuation', JSON.stringify({
        capBytes: MAX_BUFFERED_BYTES,
      }))
      failed = true
      flushBuffered()
      return
    }
    chunks.push(buffer)
  })
  source.on('end', onEnd)
  source.on('error', (error: Error) => {
    failed = true
    // A stream that errored never produced a usable turn, so there is nothing
    // worth continuing. Forward the failure the way the route expects.
    out.destroy(error)
  })

  return proxy
}

/**
 * Reconstruct the assistant turn from buffered SSE frames.
 *
 * The frames are exactly what the client would have received, so accumulating
 * `choices[0].delta` reconstructs the turn upstream believes it produced. Only
 * the OpenAI chunk shape is handled; an unparseable buffer returns undefined and
 * the caller emits the first turn unchanged.
 */
export function assistantMessageFromFrames(chunks: readonly Buffer[]): ChatMessage | undefined {
  const content: string[] = []
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()

  for (const chunk of chunks) {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let parsed: any
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = parsed?.choices?.[0]
      const delta = choice?.delta ?? choice?.message
      if (!delta) continue
      if (typeof delta.content === 'string') content.push(delta.content)
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call?.index === 'number' ? call.index : 0
          const slot = toolCalls.get(index) ?? { id: '', name: '', args: '' }
          if (typeof call?.id === 'string' && call.id) slot.id = call.id
          if (typeof call?.function?.name === 'string' && call.function.name) slot.name = call.function.name
          if (typeof call?.function?.arguments === 'string') slot.args += call.function.arguments
          toolCalls.set(index, slot)
        }
      }
    }
  }

  const assembled = Array.from(toolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, slot]) => slot)
    .filter((slot) => slot.name)

  if (content.length === 0 && assembled.length === 0) return undefined

  return {
    role: 'assistant',
    content: content.join('') || null,
    ...(assembled.length > 0
      ? {
        tool_calls: assembled.map((slot, index) => ({
          id: slot.id || `call_stream_${index}`,
          type: 'function',
          function: { name: slot.name, arguments: slot.args },
        })),
      }
      : {}),
  } as ChatMessage
}
