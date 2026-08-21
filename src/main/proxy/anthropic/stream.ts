import { PassThrough } from 'node:stream'
import { createParser, type EventSourceMessage } from 'eventsource-parser'

export const DEFAULT_ANTHROPIC_PING_INTERVAL_MS = 15_000

export function anthropicPingIntervalMsFromEnv(): number {
  const raw = process.env.CHAT2API_ANTHROPIC_PING_INTERVAL_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_ANTHROPIC_PING_INTERVAL_MS

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_ANTHROPIC_PING_INTERVAL_MS
}

export interface AnthropicStreamOptions {
  messageId: string
  model: string
  pingIntervalMs?: number
  onSuccess?: () => void
  onFailure?: (error: Error) => void
}

type DestroyableReadable = NodeJS.ReadableStream & {
  destroy?: (error?: Error) => void
  destroyed?: boolean
  readableEnded?: boolean
}

function normalizedStreamError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(String(error || fallback))
}

export function createAnthropicMessagesStream(
  sourceStream: NodeJS.ReadableStream,
  options: AnthropicStreamOptions,
): PassThrough {
  const output = new PassThrough()
  const source = sourceStream as DestroyableReadable
  const pingIntervalMs = options.pingIntervalMs ?? anthropicPingIntervalMsFromEnv()
  let textBlockIndex: number | undefined
  let thinkingBlockIndex: number | undefined
  const toolBlockIndices = new Map<number, number>()
  let nextBlockIndex = 0
  let terminalSent = false
  let streamFailed = false
  let sourceEnded = false
  let outcomeRecorded = false
  let pingTimer: NodeJS.Timeout | undefined
  let inputTokens = 0
  let outputTokens = 0

  const writeEvent = (type: string, payload: Record<string, any> = {}) => {
    if (output.destroyed || output.writableEnded) return
    output.write(`event: ${type}\n`)
    output.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`)
  }

  const stopPingTimer = () => {
    if (!pingTimer) return
    clearInterval(pingTimer)
    pingTimer = undefined
  }

  const recordSuccess = () => {
    if (outcomeRecorded) return
    outcomeRecorded = true
    stopPingTimer()
    options.onSuccess?.()
  }

  const recordFailure = (error: Error) => {
    if (outcomeRecorded) return
    outcomeRecorded = true
    stopPingTimer()
    options.onFailure?.(error)
  }

  const closeBlocks = () => {
    if (thinkingBlockIndex !== undefined) {
      writeEvent('content_block_stop', { index: thinkingBlockIndex })
      thinkingBlockIndex = undefined
    }
    if (textBlockIndex !== undefined) {
      writeEvent('content_block_stop', { index: textBlockIndex })
      textBlockIndex = undefined
    }
    for (const blockIndex of toolBlockIndices.values()) {
      writeEvent('content_block_stop', { index: blockIndex })
    }
    toolBlockIndices.clear()
  }

  const completeStream = (stopReason: 'end_turn' | 'max_tokens' | 'tool_use') => {
    if (terminalSent || streamFailed) return
    closeBlocks()
    writeEvent('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    writeEvent('message_stop')
    terminalSent = true
    recordSuccess()
    output.end()
  }

  const failStream = (error: unknown, fallback = 'Upstream stream failed.') => {
    if (streamFailed || terminalSent) return
    streamFailed = true
    const normalized = normalizedStreamError(error, fallback)
    recordFailure(normalized)
    writeEvent('error', {
      error: { type: 'api_error', message: normalized.message },
    })
    output.end()
  }

  const handleUpstreamEvent = (event: EventSourceMessage) => {
    const data = event.data.trim()
    if (!data || terminalSent || streamFailed) return
    if (data === '[DONE]') {
      completeStream(toolBlockIndices.size > 0 ? 'tool_use' : 'end_turn')
      return
    }

    try {
      const parsed = JSON.parse(data)
      if (parsed?.error) {
        throw new Error(parsed.error.message || parsed.message || 'Upstream stream failed')
      }
      const choice = parsed.choices?.[0]
      if (!choice) return
      const delta = choice.delta
      inputTokens = parsed.usage?.prompt_tokens ?? inputTokens
      outputTokens = parsed.usage?.completion_tokens ?? outputTokens

      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
        if (thinkingBlockIndex === undefined) {
          thinkingBlockIndex = nextBlockIndex
          nextBlockIndex += 1
          writeEvent('content_block_start', {
            index: thinkingBlockIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          })
        }
        writeEvent('content_block_delta', {
          index: thinkingBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        })
      }

      if (typeof delta?.content === 'string' && delta.content) {
        if (textBlockIndex === undefined) {
          if (thinkingBlockIndex !== undefined) {
            writeEvent('content_block_stop', { index: thinkingBlockIndex })
            thinkingBlockIndex = undefined
          }
          textBlockIndex = nextBlockIndex
          nextBlockIndex += 1
          writeEvent('content_block_start', {
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          })
        }
        writeEvent('content_block_delta', {
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        })
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const toolIndex = Number.isInteger(toolCall.index) ? toolCall.index : 0
          let blockIndex = toolBlockIndices.get(toolIndex)
          if (blockIndex === undefined && toolCall.function?.name) {
            if (thinkingBlockIndex !== undefined) {
              writeEvent('content_block_stop', { index: thinkingBlockIndex })
              thinkingBlockIndex = undefined
            }
            if (textBlockIndex !== undefined) {
              writeEvent('content_block_stop', { index: textBlockIndex })
              textBlockIndex = undefined
            }
            blockIndex = nextBlockIndex
            nextBlockIndex += 1
            toolBlockIndices.set(toolIndex, blockIndex)
            writeEvent('content_block_start', {
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: toolCall.id || `toolu_${options.messageId}_${toolIndex}`,
                name: toolCall.function.name,
                input: {},
              },
            })
          }
          if (blockIndex !== undefined && toolCall.function?.arguments) {
            writeEvent('content_block_delta', {
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments,
              },
            })
          }
        }
      }

      if (choice.finish_reason) {
        const stopReason = choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn'
        completeStream(stopReason)
      }
    } catch (error) {
      failStream(error)
    }
  }

  const parser = createParser({
    onEvent: handleUpstreamEvent,
    onError: error => failStream(error, 'Invalid upstream SSE event.'),
  })

  writeEvent('message_start', {
    message: {
      id: options.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: options.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  })

  if (pingIntervalMs > 0) {
    pingTimer = setInterval(() => writeEvent('ping'), pingIntervalMs)
    pingTimer.unref?.()
  }

  source.on('data', (chunk: Buffer | string) => {
    if (!terminalSent && !streamFailed) parser.feed(chunk.toString())
  })
  source.once('end', () => {
    sourceEnded = true
    if (terminalSent || streamFailed) return
    try {
      parser.reset({ consume: true })
    } catch (error) {
      failStream(error, 'Invalid trailing upstream SSE event.')
      return
    }
    if (!terminalSent && !streamFailed) {
      failStream(new Error('Upstream stream ended before a terminal completion event.'))
    }
  })
  source.once('error', error => failStream(error))
  source.once('close', () => {
    if (!sourceEnded && !terminalSent && !streamFailed) {
      failStream(new Error('Upstream stream closed before completion.'))
    }
  })

  output.once('close', () => {
    stopPingTimer()
    if (!terminalSent && !streamFailed) {
      recordFailure(Object.assign(
        new Error('Anthropic-compatible client disconnected.'),
        { status: 499, code: 'client_disconnected' },
      ))
    }
    if (!terminalSent && !source.destroyed && typeof source.destroy === 'function') {
      source.destroy()
    }
  })

  return output
}
