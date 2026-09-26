/**
 * Streaming retrieval loop — Task 2.3b phase C.
 *
 * The properties under test are the ones a client would notice:
 *
 *   - an armed turn with no local call produces byte-identical output;
 *   - an armed turn with a local call produces ONLY the continuation turn;
 *   - a failed or budget-exhausted turn still emits the first turn, because the
 *     client already paid for it;
 *   - a stream that errored is never continued;
 *   - the route's metadata reads reach the underlying stream, and after a
 *     continuation they reach the NEW stream;
 *   - the loop still fires when the stream outlives its async-local context,
 *     which is the production shape for a streaming forwarder.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import {
  createRetrievalAwareStream,
  assistantMessageFromFrames,
} from '../../../src/main/proxy/services/retrievalStream.ts'
import {
  runWithLocalToolContext,
  buildRetrievalContinuation,
  type LocalToolContext,
} from '../../../src/main/proxy/toolCalling/localToolCalls.ts'
import { CompressionArchive } from '../../../src/main/proxy/services/compressionArchive.ts'
import { RETRIEVE_TOOL_NAME } from '../../../src/main/proxy/services/retrievalTool.ts'
import type { LocalToolCallRecord } from '../../../src/main/proxy/toolCalling/types.ts'
import type { ChatMessage } from '../../../src/main/proxy/types.ts'

const OMITTED = 'the omitted span'
const ENABLED = { enabled: true, maxRetrievalsPerRequest: 2 }

function context(overrides: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    scope: 'scope-1',
    archive: new CompressionArchive({
      filePath: `${process.env.TEMP}\\.retrieval-stream-test.json`,
      ttlMs: 60_000,
      maxChars: 1_000_000,
      now: () => 1_000,
    }),
    advertised: ['aaaa'],
    settings: ENABLED,
    used: 0,
    pending: [],
    ...overrides,
  }
}

function sse(payload: unknown): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`)
}

function roleChunk(): Buffer {
  return sse({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
}

function textChunk(text: string): Buffer {
  return sse({ choices: [{ index: 0, delta: { content: text } }] })
}

function callChunk(id: string, name: string, args: string): Buffer {
  return sse({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
    }],
  })
}

const DONE = Buffer.from('data: [DONE]\n\n')

function drain(stream: PassThrough): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

function localRecord(overrides: Partial<LocalToolCallRecord> = {}): LocalToolCallRecord {
  return {
    id: 'call_ccr_1',
    name: RETRIEVE_TOOL_NAME,
    arguments: JSON.stringify({ hash: 'aaaa' }),
    content: OMITTED,
    isError: false,
    ...overrides,
  }
}

type Continue = (
  local: LocalToolCallRecord[],
  assistant: ChatMessage,
) => Promise<(PassThrough & Record<string, unknown>) | undefined>

function wrap(source: PassThrough & Record<string, unknown>, ctx: LocalToolContext, continueTurn: Continue, budget = 2) {
  return createRetrievalAwareStream({ source, context: ctx, continue: continueTurn, budget })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// The production shape
// ---------------------------------------------------------------------------

test('REGRESSION: the loop fires when the stream outlives its async-local context', async () => {
  // A streaming forwarder resolves as soon as the PassThrough exists, so the
  // `AsyncLocalStorage` context is gone long before `end`. An earlier version
  // read the context from ALS inside the `end` handler, which made the loop
  // unreachable in production — while every test passed, because they all
  // awaited the whole flow inside `runWithLocalToolContext` instead of
  // returning the stream and letting it finish afterwards.
  const ctx = context()
  const source = new PassThrough()
  const next = new PassThrough()
  let continued = false

  const wrapped = wrap(source, ctx, async () => {
    continued = true
    return next as never
  })
  const collected = drain(wrapped)

  const returned = runWithLocalToolContext(ctx, () => {
    ctx.pending = [localRecord()]
    return source
  })
  assert.equal(returned, source, 'the forwarder hands back the same stream object')

  source.write(callChunk('call_1', RETRIEVE_TOOL_NAME, '{"hash":"aaaa"}'))
  source.write(DONE)
  source.end()
  await tick()
  next.write(textChunk('CONTINUATION TURN'))
  next.write(DONE)
  next.end()

  const output = await collected
  assert.equal(continued, true, 'the loop must fire on a stream that outlived its context')
  assert.doesNotMatch(output, /call_1/)
  assert.match(output, /CONTINUATION TURN/)
})

// ---------------------------------------------------------------------------
// Frame reconstruction
// ---------------------------------------------------------------------------

test('an assistant turn is reconstructed from streamed frames', () => {
  const message = assistantMessageFromFrames([
    roleChunk(),
    textChunk('before '),
    textChunk('after'),
    callChunk('call_1', 'exec', '{"cmd":"ls"}'),
    DONE,
  ])!
  assert.equal(message.role, 'assistant')
  assert.equal(message.content, 'before after')
  assert.equal((message as any).tool_calls.length, 1)
  assert.equal((message as any).tool_calls[0].id, 'call_1')
  assert.equal((message as any).tool_calls[0].function.arguments, '{"cmd":"ls"}')
})

test('streamed tool-call arguments are concatenated across frames', () => {
  const message = assistantMessageFromFrames([
    callChunk('call_1', 'exec', '{"cmd":'),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }),
  ])!
  assert.equal((message as any).tool_calls[0].function.arguments, '{"cmd":"ls"}')
})

test('an empty or unparseable buffer yields no assistant message', () => {
  assert.equal(assistantMessageFromFrames([]), undefined)
  assert.equal(assistantMessageFromFrames([DONE]), undefined)
  assert.equal(assistantMessageFromFrames([Buffer.from('data: {bad json\n\n')]), undefined)
})

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

test('an armed turn with no local call emits its first turn unchanged', async () => {
  const source = new PassThrough()
  const collected = drain(wrap(source, context(), async () => undefined))

  source.write(roleChunk())
  source.write(textChunk('hello'))
  source.write(DONE)
  source.end()

  assert.match(await collected, /hello/)
})

test('an armed turn with a local call emits ONLY the continuation turn', async () => {
  const ctx = context()
  const source = new PassThrough()
  const next = new PassThrough()

  const collected = drain(wrap(source, ctx, async (local, assistant) => {
    // The continuation really is built from the reconstructed assistant turn.
    const messages = buildRetrievalContinuation({
      messages: [{ role: 'user', content: 'go' } as ChatMessage],
      assistantMessage: assistant,
      local,
    })!
    assert.equal(messages[messages.length - 1].content, OMITTED)
    return next as never
  }))

  ctx.pending = [localRecord()]
  source.write(callChunk('call_1', RETRIEVE_TOOL_NAME, '{"hash":"aaaa"}'))
  source.write(DONE)
  source.end()
  await tick()
  next.write(textChunk('SECOND TURN TEXT'))
  next.write(DONE)
  next.end()

  const output = await collected
  // The first turn carried only the tool call, so what must be absent is that
  // call, not the continuation text. An earlier version of this test asserted the
  // continuation text was absent, which is the opposite of the property.
  assert.doesNotMatch(output, /"call_1"/, 'the discarded turn must not reach the client')
  assert.doesNotMatch(output, /retrieve_tool_output/)
  assert.match(output, /SECOND TURN TEXT/)
})

test('an exhausted budget still emits the first turn', async () => {
  const ctx = context()
  const source = new PassThrough()
  const collected = drain(wrap(source, ctx, async () => undefined, 0))

  ctx.pending = [localRecord()]
  source.write(textChunk('FIRST TURN'))
  source.write(DONE)
  source.end()

  assert.match(await collected, /FIRST TURN/, 'the client already paid for this turn')
})

test('a stream that errored is never continued', async () => {
  const ctx = context()
  const source = new PassThrough()
  let continued = false
  const wrapped = wrap(source, ctx, async () => {
    continued = true
    return undefined
  })
  const failed = new Promise((resolve) => wrapped.on('error', resolve))

  ctx.pending = [localRecord()]
  source.write(textChunk('partial'))
  source.destroy(new Error('upstream exploded'))

  await failed
  assert.equal(continued, false, 'a failed turn has no usable assistant message to continue from')
})

test('a continuation that returns nothing still emits the first turn', async () => {
  const ctx = context()
  const source = new PassThrough()
  const collected = drain(wrap(source, ctx, async () => undefined))

  ctx.pending = [localRecord()]
  source.write(textChunk('FIRST TURN'))
  source.write(DONE)
  source.end()

  assert.match(await collected, /FIRST TURN/)
})

test('a continuation that throws still emits the first turn', async () => {
  const ctx = context()
  const source = new PassThrough()
  const collected = drain(wrap(source, ctx, async () => {
    throw new Error('continuation exploded')
  }))

  ctx.pending = [localRecord()]
  source.write(textChunk('FIRST TURN'))
  source.write(DONE)
  source.end()

  assert.match(await collected, /FIRST TURN/)
})

// ---------------------------------------------------------------------------
// Metadata passthrough
// ---------------------------------------------------------------------------

test('metadata reads reach the underlying stream', () => {
  const source = Object.assign(new PassThrough(), { qwenAiEffectiveAccountId: 'account-9' })
  const wrapped = wrap(source, context(), async () => undefined)
  assert.equal((wrapped as any).qwenAiEffectiveAccountId, 'account-9')
})

test('after a continuation, metadata reads reach the NEW stream', async () => {
  const source = Object.assign(new PassThrough(), { qwenAiEffectiveAccountId: 'first-turn' })
  const next = Object.assign(new PassThrough(), { qwenAiEffectiveAccountId: 'second-turn' })
  const ctx = context()
  const wrapped = wrap(source, ctx, async () => next as never)
  const collected = drain(wrapped)

  ctx.pending = [localRecord()]
  source.write(callChunk('call_1', RETRIEVE_TOOL_NAME, '{"hash":"aaaa"}'))
  source.write(DONE)
  source.end()
  await tick()
  next.write(DONE)
  next.end()
  await collected

  assert.equal(
    (wrapped as any).qwenAiEffectiveAccountId,
    'second-turn',
    'the client receives the second turn, so the metadata must be the second turn\'s',
  )
})

test('a property the route writes back is readable afterwards', () => {
  const source = Object.assign(new PassThrough(), { qwenAiFailure: undefined as Error | undefined })
  const wrapped = wrap(source, context(), async () => undefined)
  ;(wrapped as any).qwenAiFailure = new Error('stamped by the route')
  assert.equal(((wrapped as any).qwenAiFailure as Error).message, 'stamped by the route')
})

test('stream methods are callable through the wrapper', () => {
  const wrapped = wrap(new PassThrough(), context(), async () => undefined)
  assert.equal(typeof wrapped.on, 'function')
  assert.equal(typeof wrapped.write, 'function')
  assert.equal(typeof wrapped.destroy, 'function')
  assert.equal('qwenAiSessionState' in wrapped, false, 'an absent property is not invented')
})
