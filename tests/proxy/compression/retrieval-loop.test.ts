/**
 * The proxy-internal tool loop — Task 2.3b phase A.
 *
 * The behavior under test is the one a client actually observes:
 *
 *   - the retrieval call is never in the response it receives;
 *   - the model gets a second turn with the resolved content, and it is that
 *     second response the client gets;
 *   - the loop stops at the budget instead of spending the context window;
 *   - a streaming request is not armed at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { CompressionArchive } from '../../../src/main/proxy/services/compressionArchive.ts'
import { RETRIEVE_TOOL_NAME } from '../../../src/main/proxy/services/retrievalTool.ts'
import { runWithRetrievalLoop, type RetrievalLoopInput } from '../../../src/main/proxy/services/retrievalLoop.ts'
import {
  partitionLocalToolCalls,
  runWithLocalToolContext,
  type LocalToolContext,
} from '../../../src/main/proxy/toolCalling/localToolCalls.ts'
import type { ToolCallingPlan, NormalizedToolCall } from '../../../src/main/proxy/toolCalling/types.ts'
import type { ChatCompletionRequest } from '../../../src/main/proxy/types.ts'

const OMITTED = 'the omitted diagnostic span'
const ENABLED = { enabled: true, maxRetrievalsPerRequest: 2 }
const OFF = { enabled: false, maxRetrievalsPerRequest: 2 }

let counter = 0
function archive(): CompressionArchive {
  counter += 1
  return new CompressionArchive({
    filePath: path.join(os.tmpdir(), `chat2api-loop-${process.pid}-${counter}.json`),
    ttlMs: 60_000,
    maxChars: 1_000_000,
    now: () => 1_000,
  })
}

function context(overrides: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    scope: 'qwen-ai:account-1:session-7',
    archive: archive(),
    advertised: [],
    settings: ENABLED,
    used: 0,
    pending: [],
    ...overrides,
  }
}

function plan(): ToolCallingPlan {
  return {
    mode: 'managed_xml',
    protocol: 'managed_xml',
    clientAdapterId: 'openai',
    providerId: 'qwen-ai',
    tools: [],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set([RETRIEVE_TOOL_NAME]),
    allowedUpstreamToolNames: new Set([RETRIEVE_TOOL_NAME]),
    workflowContinuation: false,
    failedToolResultPending: false,
  } as unknown as ToolCallingPlan
}

const BASE_REQUEST = {
  model: 'test-model',
  stream: false,
  messages: [{ role: 'user', content: 'summarize' }],
} as unknown as ChatCompletionRequest

/** A response shaped like the non-stream OpenAI payload, carrying one call. */
function responseWith(hash: string, id: string, content: string | null) {
  return {
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content, tool_calls: [{ id, name: RETRIEVE_TOOL_NAME, arguments: JSON.stringify({ hash }) }] },
    }],
  }
}

function plainResponse(text: string) {
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  }
}

function call(name: string, hash?: unknown): NormalizedToolCall {
  return {
    id: 'x', index: 0, name,
    arguments: hash === undefined ? '{}' : JSON.stringify({ hash }),
    protocol: 'managed_xml',
  } as NormalizedToolCall
}

/**
 * A stand-in for the forwarder: it partitions whatever the "upstream" produced
 * and reports the partition back, which is exactly what `applyNonStreamResponse`
 * does in production.
 */
function harness(
  ctx: LocalToolContext,
  upstream: Array<Record<string, unknown>>,
  requests: ChatCompletionRequest[],
) {
  return async (request: ChatCompletionRequest) => {
    requests.push(request)
    const body = upstream[Math.min(requests.length - 1, upstream.length - 1)]
    return runWithLocalToolContext(ctx, async () => {
      const p = plan()
      const out = partitionLocalToolCalls({
        plan: p,
        toolCalls: (body as any).__calls ?? [],
      })
      return {
        choices: [{
          index: 0,
          finish_reason: out.local.length > 0 && out.clientCalls.length === 0 ? 'stop' : 'tool_calls',
          message: {
            role: 'assistant',
            content: (body as any).content ?? null,
            tool_calls: out.clientCalls.length > 0 ? out.clientCalls : undefined,
          },
        }],
      }
    })
  }
}

test('a response with no local call is returned as-is, with no second attempt', async () => {
  const requests: ChatCompletionRequest[] = []
  const input: RetrievalLoopInput = {
    attempt: harness(context(), [{ content: 'hello' }], requests),
    request: BASE_REQUEST,
    context: context(),
    baseRequest: BASE_REQUEST,
  }
  const outcome = await runWithRetrievalLoop(input)

  assert.equal(requests.length, 1)
  assert.equal(outcome.turns, 0)
  assert.equal(outcome.stopReason, 'no-local-calls')
  assert.equal(outcome.response.choices[0].message.content, 'hello')
})

test('a retrieval call produces a second attempt and the client gets THAT response', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const ctx = context({ archive: store, scope: 'qwen-ai:account-1:session-7', advertised: [hash] })
  const requests: ChatCompletionRequest[] = []

  const outcome = await runWithRetrievalLoop({
    attempt: harness(ctx, [
      { content: null, __calls: [call(RETRIEVE_TOOL_NAME, hash)] },
      { content: 'the answer, using the span' },
    ], requests),
    request: BASE_REQUEST,
    context: ctx,
    baseRequest: BASE_REQUEST,
  })

  assert.equal(requests.length, 2, 'a continuation turn must actually happen')
  assert.equal(outcome.turns, 1)
  assert.equal(outcome.resolved.length, 1)
  assert.equal(outcome.resolved[0].content, OMITTED)
  assert.equal(outcome.response.choices[0].message.content, 'the answer, using the span',
    'the client must receive the response produced AFTER the expansion')

  // The continuation carries the assistant turn and the resolved result.
  const sent = requests[1].messages as any[]
  const toolResult = sent.find((m) => m.role === 'tool')
  assert.ok(toolResult, 'the continuation must include the tool result')
  assert.equal(toolResult.content, OMITTED)
  assert.equal(toolResult.tool_call_id, outcome.resolved[0].id)
})

test('the client never sees the retrieval call', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const ctx = context({ archive: store, scope: 'qwen-ai:account-1:session-7', advertised: [hash] })
  const requests: ChatCompletionRequest[] = []

  const outcome = await runWithRetrievalLoop({
    attempt: harness(ctx, [
      { content: null, __calls: [call(RETRIEVE_TOOL_NAME, hash)] },
      { content: 'done' },
    ], requests),
    request: BASE_REQUEST,
    context: ctx,
    baseRequest: BASE_REQUEST,
  })

  const clientCalls = outcome.response.choices[0].message.tool_calls
  assert.equal(clientCalls, undefined, 'the final response carries no client tool calls')
})

test('the loop stops at the budget instead of re-expanding forever', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const ctx = context({ archive: store, scope: 'qwen-ai:account-1:session-7', advertised: [hash] })
  const requests: ChatCompletionRequest[] = []

  // Every attempt asks again, forever.
  const outcome = await runWithRetrievalLoop({
    attempt: harness(ctx, [{ content: null, __calls: [call(RETRIEVE_TOOL_NAME, hash)] }], requests),
    request: BASE_REQUEST,
    context: ctx,
    baseRequest: BASE_REQUEST,
  })

  assert.equal(outcome.stopReason, 'budget-exhausted')
  assert.equal(requests.length, 2, 'a budget of 2 permits exactly two retrievals')
  assert.ok(outcome.turns <= 2)
})

test('a streaming request is not armed, so the model never asks', async () => {
  const requests: ChatCompletionRequest[] = []
  const streamingRequest = { ...BASE_REQUEST, stream: true } as ChatCompletionRequest
  const ctx = context({ settings: { enabled: true, maxRetrievalsPerRequest: 4 } })

  const outcome = await runWithRetrievalLoop({
    attempt: harness(ctx, [{ content: 'streamed text' }], requests),
    request: streamingRequest,
    context: ctx,
    baseRequest: streamingRequest,
  })

  assert.equal(requests.length, 1, 'a streaming request takes exactly one attempt')
  assert.equal(outcome.turns, 0)
  assert.equal(outcome.response.choices[0].message.content, 'streamed text')
})

test('retrieval switched off never triggers a continuation', async () => {
  const ctx = context({ settings: OFF })
  const requests: ChatCompletionRequest[] = []
  const outcome = await runWithRetrievalLoop({
    attempt: harness(ctx, [{ content: 'plain' }], requests),
    request: BASE_REQUEST,
    context: ctx,
    baseRequest: BASE_REQUEST,
  })
  assert.equal(requests.length, 1)
  assert.equal(outcome.turns, 0)
})

test('an aborted client stops the loop', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const ctx = context({ archive: store, scope: 'qwen-ai:account-1:session-7', advertised: [hash] })
  const controller = new AbortController()
  const requests: ChatCompletionRequest[] = []

  const outcome = await runWithRetrievalLoop({
    attempt: async (request) => {
      requests.push(request)
      controller.abort()
      return runWithLocalToolContext(ctx, async () => {
        const out = partitionLocalToolCalls({ plan: plan(), toolCalls: [call(RETRIEVE_TOOL_NAME, hash)] })
        return {
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: null, tool_calls: out.clientCalls.length ? out.clientCalls : undefined },
          }],
        }
      })
    },
    request: BASE_REQUEST,
    context: ctx,
    baseRequest: BASE_REQUEST,
    signal: controller.signal,
  })

  assert.equal(outcome.stopReason, 'client-aborted')
  assert.equal(requests.length, 1, 'an abort must not start a second upstream request')
})
