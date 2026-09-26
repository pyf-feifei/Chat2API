/**
 * `retrieve_tool_output` — Phase 2.3a.
 *
 * The pure half: the tool definition, the injection decision, hash extraction,
 * and the local resolver. Every failure mode must produce a normal tool result,
 * because the alternative is a turn that dies on a recoverable mistake.
 *
 * The stream interception that calls `resolveRetrievalCall` is Phase 2.3b and is
 * not started; these tests are the contract that phase will implement against.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { CompressionArchive } from '../../../src/main/proxy/services/compressionArchive.ts'
import {
  RETRIEVE_TOOL_NAME,
  DEFAULT_MAX_RETRIEVALS_PER_REQUEST,
  buildRetrieveTool,
  isRetrievalToolName,
  shouldInjectRetrievalTool,
  stripRetrievalTool,
  extractArchiveHashes,
  resolveRetrievalCall,
} from '../../../src/main/proxy/services/retrievalTool.ts'
import { getRetrievalSettings } from '../../../src/main/proxy/services/retrievalSettings.ts'
import type { NormalizedToolCall } from '../../../src/main/proxy/toolCalling/types.ts'

const SCOPE = 'qwen-ai:account-1:session-7'
const OMITTED = 'diagnostic record 100\ndiagnostic record 101\ndiagnostic record 102'

let counter = 0
function archive(): CompressionArchive {
  counter += 1
  return new CompressionArchive({
    filePath: path.join(os.tmpdir(), `chat2api-retrieval-${process.pid}-${counter}.json`),
    ttlMs: 60_000,
    maxChars: 1_000_000,
    now: () => 1_000,
  })
}

const ENABLED = { enabled: true, maxRetrievalsPerRequest: DEFAULT_MAX_RETRIEVALS_PER_REQUEST }
const DISABLED = { enabled: false, maxRetrievalsPerRequest: 4 }

function call(hash: unknown, id = 'call_1'): NormalizedToolCall {
  return {
    id,
    index: 0,
    name: RETRIEVE_TOOL_NAME,
    arguments: JSON.stringify({ hash }),
    protocol: 'managed_xml',
  } as NormalizedToolCall
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

test('the tool declares the hash argument the marker actually emits', () => {
  const tool = buildRetrieveTool()
  assert.equal(tool.name, RETRIEVE_TOOL_NAME)
  const schema = tool.parameters as any
  assert.deepEqual(schema.required, ['hash'])
  assert.equal(schema.properties.hash.type, 'string')
  assert.match(schema.properties.hash.description, /archive:tool:<hash>/,
    'the description should point the model at the marker that carries the hash')
})

test('the tool is identifiable by name', () => {
  assert.equal(isRetrievalToolName(RETRIEVE_TOOL_NAME), true)
  assert.equal(isRetrievalToolName('retrieve_tool_output_v2'), false)
  assert.equal(isRetrievalToolName(undefined), false)
  assert.equal(isRetrievalToolName(''), false)
})

test('the tool is stripped before the request reaches the provider', () => {
  const clientTool = { name: 'exec', description: 'x', parameters: {} } as any
  const tools = [clientTool, buildRetrieveTool()]

  const stripped = stripRetrievalTool(tools)!
  assert.equal(stripped.length, 1)
  assert.equal(stripped[0].name, 'exec')
  assert.equal(
    tools.length, 2,
    'stripping must not mutate the caller\'s array',
  )
})

test('stripping is a no-op when the tool was never added', () => {
  const tools = [{ name: 'exec', description: 'x', parameters: {} }] as any
  assert.equal(stripRetrievalTool(tools), tools, 'an unchanged list should be returned by identity')
  assert.equal(stripRetrievalTool(undefined), undefined)
})

// ---------------------------------------------------------------------------
// Injection decision
// ---------------------------------------------------------------------------

test('the tool is injected only when something was archived and retrieval is on', () => {
  assert.equal(shouldInjectRetrievalTool(1, ENABLED), true)
  assert.equal(shouldInjectRetrievalTool(0, ENABLED), false, 'nothing archived, nothing to retrieve')
  assert.equal(shouldInjectRetrievalTool(1, DISABLED), false, 'retrieval off')
  assert.equal(shouldInjectRetrievalTool(-1, ENABLED), false)
  assert.equal(shouldInjectRetrievalTool(1.5, ENABLED), false, 'a non-integer is not a count')
})

// ---------------------------------------------------------------------------
// Hash extraction
// ---------------------------------------------------------------------------

test('hashes are extracted from string and array content, de-duplicated in order', () => {
  const marker = (hash: string) => `[Chat2API archive:tool:${hash} 40 chars / 3 lines omitted; call retrieve_tool_output with this hash to expand]`
  const messages = [
    { content: 'plain text with no marker' },
    { content: `${marker('aaaaaaaaaaaaaaaa')} and ${marker('bbbbbbbbbbbbbbbb')}` },
    { content: [{ type: 'text', text: marker('aaaaaaaaaaaaaaaa') }, { type: 'image_url', image_url: { url: 'x' } }] },
  ]
  assert.deepEqual(extractArchiveHashes(messages), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
})

test('no marker means no hashes', () => {
  assert.deepEqual(extractArchiveHashes([{ content: 'nothing here' }, { content: null }]), [])
  assert.deepEqual(extractArchiveHashes([]), [])
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('a valid call returns the exact archived text', () => {
  const store = archive()
  const hash = store.record(SCOPE, OMITTED)!
  const outcome = resolveRetrievalCall({
    call: call(hash),
    archive: store,
    scope: SCOPE,
    advertised: [hash],
    retrievalsUsed: 0,
    settings: ENABLED,
  })

  assert.equal(outcome.handled, true)
  assert.equal(outcome.result.isError, false)
  assert.equal(outcome.result.content, OMITTED)
  assert.equal(outcome.result.toolCallId, 'call_1')
})

test('a call for another tool is not ours and must pass through untouched', () => {
  const store = archive()
  const hash = store.record(SCOPE, OMITTED)!
  const foreign = { ...call(hash), name: 'exec' } as NormalizedToolCall

  const outcome = resolveRetrievalCall({
    call: foreign,
    archive: store,
    scope: SCOPE,
    advertised: [hash],
    retrievalsUsed: 0,
    settings: ENABLED,
  })
  assert.equal(outcome.handled, false, 'the response path must hand this to the client')
})

test('an unknown hash is a normal error result, not a throw', () => {
  const store = archive()
  const outcome = resolveRetrievalCall({
    call: call('0123456789abcdef'),
    archive: store,
    scope: SCOPE,
    // Advertised, so the archive is consulted and misses.
    advertised: ['0123456789abcdef'],
    retrievalsUsed: 0,
    settings: ENABLED,
  })
  assert.equal(outcome.handled, true)
  assert.equal(outcome.result.isError, true)
  assert.match(outcome.result.content, /no longer available|expired|evicted/i)
})

test('a hash this request never advertised is refused before the archive is read', () => {
  // A hallucinated or cross-request hash must not resolve. The archive is scoped
  // anyway, but refusing here means a model cannot probe for other turns' spans.
  const store = archive()
  const otherHash = store.record(SCOPE, 'a different conversation span')!
  const outcome = resolveRetrievalCall({
    call: call(otherHash),
    archive: store,
    scope: SCOPE,
    advertised: [],
    retrievalsUsed: 0,
    settings: ENABLED,
  })
  assert.equal(outcome.result.isError, true)
  assert.match(outcome.result.content, /No omitted span in this conversation/)
})

test('a hash from a different scope does not resolve even when advertised', () => {
  const store = archive()
  const hash = store.record('qwen-ai:account-2:session-9', OMITTED)!
  const outcome = resolveRetrievalCall({
    call: call(hash),
    archive: store,
    scope: 'qwen-ai:account-1:session-7',
    advertised: [hash],
    retrievalsUsed: 0,
    settings: ENABLED,
  })
  assert.equal(outcome.result.isError, true,
    'scope isolation must hold even if the hash was advertised by mistake')
})

test('a malformed argument is explained, not thrown', () => {
  const store = archive()
  for (const args of ['', '{}', 'not json', '{"hash":123}', '{"hash":""}', '{"hash":"zzz"}', '[]']) {
    const outcome = resolveRetrievalCall({
      call: { ...call('x'), arguments: args } as NormalizedToolCall,
      archive: store,
      scope: SCOPE,
      advertised: [],
      retrievalsUsed: 0,
      settings: ENABLED,
    })
    assert.equal(outcome.handled, true, `args=${JSON.stringify(args)}`)
    assert.equal(outcome.result.isError, true, `args=${JSON.stringify(args)}`)
    assert.match(outcome.result.content, /Malformed retrieve_tool_output call/)
  }
})

test('a non-hex hash is rejected even if the archive would accept the key', () => {
  const store = archive()
  for (const hash of ['A'.repeat(16), '../../etc/passwd', 'x'.repeat(15), 'x'.repeat(17), 'short']) {
    const outcome = resolveRetrievalCall({
      call: call(hash),
      archive: store,
      scope: SCOPE,
      advertised: [hash],
      retrievalsUsed: 0,
      settings: ENABLED,
    })
    assert.equal(outcome.result.isError, true, `hash=${JSON.stringify(hash)}`)
  }
})

test('the retrieval budget stops a retrieve loop with an explained result', () => {
  const store = archive()
  const hash = store.record(SCOPE, OMITTED)!
  const settings = { enabled: true, maxRetrievalsPerRequest: 2 }

  for (let used = 0; used < 2; used += 1) {
    const outcome = resolveRetrievalCall({
      call: call(hash), archive: store, scope: SCOPE,
      advertised: [hash], retrievalsUsed: used, settings,
    })
    assert.equal(outcome.result.isError, false, `call ${used + 1} should succeed`)
  }

  const exhausted = resolveRetrievalCall({
    call: call(hash), archive: store, scope: SCOPE,
    advertised: [hash], retrievalsUsed: 2, settings,
  })
  assert.equal(exhausted.result.isError, true)
  assert.match(exhausted.result.content, /budget of 2/)
  assert.match(exhausted.result.content, /Proceed with the spans already available/)
})

test('a non-positive budget falls back to the default rather than disabling retrieval', () => {
  const store = archive()
  const hash = store.record(SCOPE, OMITTED)!
  for (const max of [0, -1, 1.5, Number.NaN]) {
    const outcome = resolveRetrievalCall({
      call: call(hash), archive: store, scope: SCOPE, advertised: [hash],
      retrievalsUsed: DEFAULT_MAX_RETRIEVALS_PER_REQUEST - 1,
      settings: { enabled: true, maxRetrievalsPerRequest: max },
    })
    assert.equal(outcome.result.isError, false, `max=${max} should use the default budget`)
  }
})

test('retrieval being off refuses the call with an explanation', () => {
  const store = archive()
  const hash = store.record(SCOPE, OMITTED)!
  const outcome = resolveRetrievalCall({
    call: call(hash), archive: store, scope: SCOPE,
    advertised: [hash], retrievalsUsed: 0, settings: DISABLED,
  })
  assert.equal(outcome.handled, true)
  assert.equal(outcome.result.isError, true)
  assert.match(outcome.result.content, /Retrieval is disabled/)
})

test('an expired span reports expiry rather than pretending it is missing', () => {
  let clock = 1_000
  const store = new CompressionArchive({
    filePath: path.join(os.tmpdir(), `chat2api-retrieval-ttl-${process.pid}-${counter}.json`),
    ttlMs: 500,
    maxChars: 1_000_000,
    now: () => clock,
  })
  const hash = store.record(SCOPE, OMITTED)!
  clock += 600

  const outcome = resolveRetrievalCall({
    call: call(hash), archive: store, scope: SCOPE,
    advertised: [hash], retrievalsUsed: 0, settings: ENABLED,
  })
  assert.equal(outcome.result.isError, true)
  assert.match(outcome.result.content, /expired|evicted|no longer available/i)
})

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

test('retrieval defaults to off', () => {
  const settings = getRetrievalSettings({})
  assert.equal(settings.enabled, false)
  assert.equal(settings.maxRetrievalsPerRequest, DEFAULT_MAX_RETRIEVALS_PER_REQUEST)
})

test('the retrieval flag parses on and off, and unknown values stay off', () => {
  for (const value of ['1', 'true', 'on', 'yes', 'enabled', 'ON', ' on ']) {
    assert.equal(getRetrievalSettings({ CHAT2API_COMPRESS_RETRIEVAL: value }).enabled, true, value)
  }
  for (const value of ['0', 'false', 'off', 'disabled', 'no', '', 'maybe', '2']) {
    assert.equal(getRetrievalSettings({ CHAT2API_COMPRESS_RETRIEVAL: value }).enabled, false, value)
  }
})

test('the retrieval budget parses as a non-negative integer with a safe default', () => {
  assert.equal(getRetrievalSettings({ CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST: '0' }).maxRetrievalsPerRequest, 0)
  assert.equal(getRetrievalSettings({ CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST: '9' }).maxRetrievalsPerRequest, 9)
  for (const value of ['', 'lots', '-1', '2.5']) {
    assert.equal(
      getRetrievalSettings({ CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST: value }).maxRetrievalsPerRequest,
      DEFAULT_MAX_RETRIEVALS_PER_REQUEST,
      `value=${JSON.stringify(value)}`,
    )
  }
})
