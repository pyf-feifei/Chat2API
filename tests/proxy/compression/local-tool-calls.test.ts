/**
 * Proxy-internal tool calls — Task 2.3b, phase A (non-streaming).
 *
 * The invariant: a `retrieve_tool_output` call NEVER appears in
 * `message.tool_calls`, so it never reaches the client, and the response the
 * client eventually receives is the one produced AFTER the expansion.
 *
 * The context travels in an `AsyncLocalStorage`, so these tests also cover the
 * concurrency property: two overlapping requests must not see each other's
 * archive scope. A module-level singleton would pass every single-request test
 * here and leak in production.
 *
 * Design: `docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { CompressionArchive } from '../../../src/main/proxy/services/compressionArchive.ts'
import {
  RETRIEVE_TOOL_NAME,
  DEFAULT_MAX_RETRIEVALS_PER_REQUEST,
} from '../../../src/main/proxy/services/retrievalTool.ts'
import { getRetrievalSettings } from '../../../src/main/proxy/services/retrievalSettings.ts'
import {
  partitionLocalToolCalls,
  buildRetrievalContinuation,
  runWithLocalToolContext,
  getLocalToolContext,
  resetLocalToolIdCounter,
  type LocalToolContext,
} from '../../../src/main/proxy/toolCalling/localToolCalls.ts'
import type { ToolCallingPlan, NormalizedToolCall } from '../../../src/main/proxy/toolCalling/types.ts'
import type { ChatMessage } from '../../../src/main/proxy/types.ts'

const OMITTED = 'diagnostic record 100\ndiagnostic record 101'
const ENABLED = { enabled: true, maxRetrievalsPerRequest: 4 }
const OFF = { enabled: false, maxRetrievalsPerRequest: 4 }

let counter = 0
function archive(): CompressionArchive {
  counter += 1
  return new CompressionArchive({
    filePath: path.join(os.tmpdir(), `chat2api-ccr-${process.pid}-${counter}.json`),
    ttlMs: 60_000,
    maxChars: 1_000_000,
    now: () => 1_000,
  })
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
    allowedToolNames: new Set([RETRIEVE_TOOL_NAME, 'exec']),
    allowedUpstreamToolNames: new Set([RETRIEVE_TOOL_NAME, 'exec']),
    workflowContinuation: false,
    failedToolResultPending: false,
  } as unknown as ToolCallingPlan
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

function call(name: string, hash?: unknown): NormalizedToolCall {
  return {
    id: 'local',
    index: 0,
    name,
    arguments: hash === undefined ? '{}' : JSON.stringify({ hash }),
    protocol: 'managed_xml',
  } as NormalizedToolCall
}

/** Run the partition inside a retrieval context and return the outcome. */
async function partition(
  ctx: LocalToolContext,
  toolCalls: NormalizedToolCall[],
  p = plan(),
) {
  return runWithLocalToolContext(ctx, async () => partitionLocalToolCalls({ plan: p, toolCalls }))
}

// ---------------------------------------------------------------------------
// No context: today's behavior, unchanged
// ---------------------------------------------------------------------------

test('with no context the partition is a pass-through with fresh ids', async () => {
  resetLocalToolIdCounter()
  assert.equal(getLocalToolContext(), undefined)
  const out = partitionLocalToolCalls({ plan: plan(), toolCalls: [call('exec')] })
  assert.equal(out.clientCalls.length, 1)
  assert.equal(out.local.length, 0)
  assert.ok(out.clientCalls[0].id.startsWith('call_ccr_'))
})

test('with no context a retrieval call is NOT intercepted', async () => {
  // This is the fail-open direction. A deployment that never opted in must not
  // suddenly gain a tool it never taught, and a stray call must reach whoever
  // owns it rather than vanishing.
  const out = partitionLocalToolCalls({ plan: plan(), toolCalls: [call(RETRIEVE_TOOL_NAME, 'aa')] })
  assert.equal(out.clientCalls.length, 1)
  assert.equal(out.local.length, 0)
})

// ---------------------------------------------------------------------------
// Partition
// ---------------------------------------------------------------------------

test('a retrieval call is resolved locally and kept away from the client', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const p = plan()

  const out = await partition(context({
    archive: store,
    scope: 'qwen-ai:account-1:session-7',
    advertised: [hash],
  }), [call(RETRIEVE_TOOL_NAME, hash)], p)

  assert.equal(out.clientCalls.length, 0, 'the client must see nothing')
  assert.equal(out.local.length, 1)
  assert.equal(out.local[0].content, OMITTED)
  assert.equal(out.local[0].isError, false)
  assert.equal(p.localToolCalls?.length, 1)
})

test('a client tool call passes through untouched', async () => {
  const out = await partition(context(), [call('exec')])
  assert.equal(out.clientCalls.length, 1)
  assert.equal(out.clientCalls[0].name, 'exec')
  assert.equal(out.local.length, 0)
})

test('a mixed response splits cleanly with distinct ids', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const out = await partition(
    context({ archive: store, scope: 'qwen-ai:account-1:session-7', advertised: [hash] }),
    [call(RETRIEVE_TOOL_NAME, hash), call('exec')],
  )
  assert.equal(out.clientCalls.length, 1)
  assert.equal(out.local.length, 1)
  assert.notEqual(out.clientCalls[0].id, out.local[0].id,
    'a shared id would make the continuation ambiguous upstream')
})

test('an unresolvable retrieval is a local error, never the client\'s problem', async () => {
  const out = await partition(context({ advertised: ['0123456789abcdef'] }),
    [call(RETRIEVE_TOOL_NAME, '0123456789abcdef')])
  assert.equal(out.clientCalls.length, 0)
  assert.equal(out.local[0].isError, true)
  assert.match(out.local[0].content, /no longer available|expired|evicted/i)
})

test('retrieval switched off still keeps the call away from the client', async () => {
  // The tool was taught, so the model may call it. Handing it to the client
  // would surface a tool the client never declared.
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const out = await partition(
    context({ archive: store, scope: 'qwen-ai:account-1:session-7', advertised: [hash], settings: OFF }),
    [call(RETRIEVE_TOOL_NAME, hash)],
  )
  assert.equal(out.clientCalls.length, 0)
  assert.equal(out.local[0].isError, true)
  assert.match(out.local[0].content, /Retrieval is disabled/)
})

test('the budget is consumed across the calls of one response', async () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-1:session-7', OMITTED)!
  const out = await partition(
    context({
      archive: store,
      scope: 'qwen-ai:account-1:session-7',
      advertised: [hash],
      used: 2,
      settings: { enabled: true, maxRetrievalsPerRequest: 2 },
    }),
    [call(RETRIEVE_TOOL_NAME, hash), call(RETRIEVE_TOOL_NAME, hash), call(RETRIEVE_TOOL_NAME, hash)],
  )
  assert.equal(out.local.filter((e) => !e.isError).length, 0, 'used=2 already meets a budget of 2')
})

test('two concurrent contexts do not see each other', async () => {
  // The reason this is AsyncLocalStorage and not a module singleton. A singleton
  // passes every other test in this file and leaks one account's spans into
  // another account's conversation in production.
  const storeA = archive()
  const storeB = archive()
  const hashA = storeA.record('scope-A', 'span from A')!
  const hashB = storeB.record('scope-B', 'span from B')!

  const results = await Promise.all([
    runWithLocalToolContext(
      context({ archive: storeA, scope: 'scope-A', advertised: [hashA] }),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return partitionLocalToolCalls({ plan: plan(), toolCalls: [call(RETRIEVE_TOOL_NAME, hashA)] })
      },
    ),
    runWithLocalToolContext(
      context({ archive: storeB, scope: 'scope-B', advertised: [hashB] }),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2))
        return partitionLocalToolCalls({ plan: plan(), toolCalls: [call(RETRIEVE_TOOL_NAME, hashB)] })
      },
    ),
  ])

  assert.equal(results[0].local[0].content, 'span from A')
  assert.equal(results[1].local[0].content, 'span from B')
})

test('a context outside a run reports undefined rather than leaking', async () => {
  await runWithLocalToolContext(context(), async () => {
    assert.ok(getLocalToolContext())
  })
  assert.equal(getLocalToolContext(), undefined)
})

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

test('the continuation appends the assistant turn and its resolved results', () => {
  const next = buildRetrievalContinuation({
    // WITHOUT the assistant turn: an earlier version of this test passed it in as
    // well, which produced two assistant turns and a result with no call to
    // attach to.
    messages: [{ role: 'user', content: 'go' } as ChatMessage],
    assistantMessage: { role: 'assistant', content: null } as ChatMessage,
    local: [{
      id: 'call_abc_0',
      name: RETRIEVE_TOOL_NAME,
      arguments: JSON.stringify({ hash: 'aaaa' }),
      content: OMITTED,
      isError: false,
    }],
  })!

  assert.equal(next.length, 3)
  assert.equal(next[1].role, 'assistant')
  assert.equal((next[1] as any).tool_calls?.length, 1,
    'the assistant turn must declare the call')
  assert.equal((next[1] as any).tool_calls[0].id, 'call_abc_0')
  assert.equal(next[2].role, 'tool')
  assert.equal(next[2].tool_call_id, 'call_abc_0')
  assert.equal(next[2].content, OMITTED)
})

test('an assistant turn that already carries tool_calls is not given a second set', () => {
  const next = buildRetrievalContinuation({
    messages: [{ role: 'user', content: 'go' } as ChatMessage],
    assistantMessage: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_upstream_0', type: 'function', function: { name: 'exec', arguments: '{}' } }],
    } as unknown as ChatMessage,
    local: [{ id: 'call_1', name: RETRIEVE_TOOL_NAME, arguments: '{}', content: 'x', isError: false }],
  })!

  assert.equal((next[1] as any).tool_calls.length, 1,
    'upstream calls are preserved exactly, not merged with the local ones')
  assert.equal((next[1] as any).tool_calls[0].id, 'call_upstream_0')
})

test('an errored local result is marked', () => {
  const next = buildRetrievalContinuation({
    messages: [{ role: 'user', content: 'go' } as ChatMessage],
    assistantMessage: { role: 'assistant', content: null } as ChatMessage,
    local: [{
      id: 'call_1',
      name: RETRIEVE_TOOL_NAME,
      arguments: '{}',
      content: 'Retrieval is disabled for this request.',
      isError: true,
    }],
  })!
  assert.equal((next[2] as any).is_error, true)
})

test('an empty local set produces no continuation, and the input is never mutated', () => {
  const original: ChatMessage[] = [{ role: 'user', content: 'go' } as ChatMessage]
  assert.equal(buildRetrievalContinuation({
    messages: original,
    assistantMessage: { role: 'assistant', content: null } as ChatMessage,
    local: [],
  }), undefined)

  buildRetrievalContinuation({
    messages: original,
    assistantMessage: { role: 'assistant', content: null } as ChatMessage,
    local: [{ id: 'c1', name: RETRIEVE_TOOL_NAME, arguments: '{}', content: 'x', isError: false }],
  })
  assert.equal(original.length, 1, 'the input array must not be mutated')
})

test('retrieval defaults to off, so a clean environment resolves to disabled', () => {
  const settings = getRetrievalSettings({})
  assert.equal(settings.enabled, false)
  assert.equal(settings.maxRetrievalsPerRequest, DEFAULT_MAX_RETRIEVALS_PER_REQUEST)
})
