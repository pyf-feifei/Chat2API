import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)

function loadTypeScriptModule(path, localModules = {}) {
  const source = fs.readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected sticky test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const sessionBridge = loadTypeScriptModule('src/main/proxy/qwenAiSessionBridge.ts')
const stickyRegistryModule = loadTypeScriptModule('src/main/proxy/qwenAiStickyRegistry.ts')
const storeModule = loadTypeScriptModule('src/main/proxy/responses/store.ts', {
  '../qwenAiSessionBridge': sessionBridge,
})

const { QwenAiStickyRegistry } = stickyRegistryModule

function stickyBinding(overrides = {}) {
  return {
    providerId: 'qwen-ai',
    accountId: 'account-a',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'chat-1',
    parentId: 'resp-1',
    requestFingerprint: 'fingerprint',
    lineageKey: 'lineage-1',
    transcriptHash: 'hash-1',
    turnCount: 3,
    approxBytes: 4096,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('sticky registry counts lineages per account and prefers empty accounts', () => {
  const registry = new QwenAiStickyRegistry({ idleTtlMs: 60_000 })
  assert.equal(registry.countForAccount('account-a'), 0)

  registry.register('lineage-1', stickyBinding())
  registry.register('lineage-2', stickyBinding({ chatId: 'chat-2' }))
  registry.register('lineage-3', stickyBinding({ accountId: 'account-b', chatId: 'chat-3' }))

  assert.equal(registry.countForAccount('account-a'), 2)
  assert.equal(registry.countForAccount('account-b'), 1)
  assert.equal(registry.countForAccount('account-c'), 0)
  assert.deepEqual(registry.stats().byAccount, { 'account-a': 2, 'account-b': 1 })
})

test('sticky registry move updates the owning account', () => {
  const registry = new QwenAiStickyRegistry({ idleTtlMs: 60_000 })
  registry.register('lineage-1', stickyBinding())
  assert.equal(registry.countForAccount('account-a'), 1)

  registry.update('lineage-1', { accountId: 'account-b', chatId: 'chat-new' })
  assert.equal(registry.countForAccount('account-a'), 0)
  assert.equal(registry.countForAccount('account-b'), 1)
  assert.equal(registry.get('lineage-1').chatId, 'chat-new')
})

test('sticky registry releases idle lineages past TTL but keeps in-flight turns', () => {
  let now = 100_000
  const registry = new QwenAiStickyRegistry({ idleTtlMs: 1_000, now: () => now })
  registry.register('lineage-1', stickyBinding())
  registry.register('lineage-2', stickyBinding({ chatId: 'chat-2' }))

  // lineage-2 has an in-flight request — it must not expire.
  const releaseInFlight = registry.acquire('lineage-2')

  now += 2_000
  assert.equal(registry.countForAccount('account-a'), 1, 'in-flight lineage survives TTL')
  assert.equal(registry.get('lineage-1'), undefined, 'idle lineage expired')

  releaseInFlight()
  now += 2_000
  assert.equal(registry.get('lineage-2'), undefined, 'released lineage expires after TTL')
})

test('sticky registry touch refreshes the idle timer', () => {
  let now = 100_000
  const registry = new QwenAiStickyRegistry({ idleTtlMs: 1_000, now: () => now })
  registry.register('lineage-1', stickyBinding())
  now += 800
  registry.touch('lineage-1')
  now += 800
  assert.ok(registry.get('lineage-1'), 'touched lineage survives')
  now += 1_100
  assert.equal(registry.get('lineage-1'), undefined)
})

// ---------------------------------------------------------------------------
// Transcript & delta hashing
// ---------------------------------------------------------------------------

test('transcript hash is stable for identical messages and diverges on mutation', () => {
  const messages = [
    { role: 'system', content: 'Follow the rules.' },
    { role: 'user', content: 'Inspect the project.' },
    { role: 'assistant', content: 'Done.' },
  ]
  const hashA = sessionBridge.createQwenAiTranscriptHash(messages)
  const hashB = sessionBridge.createQwenAiTranscriptHash([...messages])
  assert.equal(hashA, hashB)

  const mutated = [...messages.slice(0, -1), { role: 'assistant', content: 'Changed.' }]
  assert.notEqual(sessionBridge.createQwenAiTranscriptHash(mutated), hashA)
})

test('delta hash distinguishes a retry (same delta) from a rewrite (different delta)', () => {
  const delta = [{ role: 'user', content: 'continue' }]
  const hashA = sessionBridge.createQwenAiDeltaHash(delta)
  assert.equal(sessionBridge.createQwenAiDeltaHash([...delta]), hashA)
  assert.notEqual(
    sessionBridge.createQwenAiDeltaHash([{ role: 'user', content: 'different turn' }]),
    hashA,
  )
})

// ---------------------------------------------------------------------------
// Binding persistence with sticky fields
// ---------------------------------------------------------------------------

test('responses conversation store preserves sticky binding fields through clone and clear', () => {
  const { ResponsesConversationStore } = storeModule
  const store = new ResponsesConversationStore({
    maxEntries: 4,
    maxTotalBytes: 64 * 1024,
    maxEntryBytes: 32 * 1024,
    persistencePath: false,
  })
  const binding = stickyBinding({
    appendedTurn: {
      prevResponseId: 'resp-prev',
      deltaHash: 'delta-abc',
      state: 'done',
    },
  })
  assert.equal(store.set('resp-2', [{ role: 'user', content: 'turn 2' }], binding), true)

  const read = store.getConversation('resp-2')
  assert.equal(read.qwenAiSessionBinding.lineageKey, 'lineage-1')
  assert.equal(read.qwenAiSessionBinding.transcriptHash, 'hash-1')
  assert.equal(read.qwenAiSessionBinding.turnCount, 3)
  assert.equal(read.qwenAiSessionBinding.appendedTurn.deltaHash, 'delta-abc')

  // Caller mutation must not leak back into the store.
  read.qwenAiSessionBinding.appendedTurn.state = 'appending'
  assert.equal(
    store.getConversation('resp-2').qwenAiSessionBinding.appendedTurn.state,
    'done',
  )
})

// ---------------------------------------------------------------------------
// Poisoned-chat circuit breaker
// ---------------------------------------------------------------------------

test('poisoned-chat error codes are classified for chain release', () => {
  const { isQwenAiPoisonedChatErrorCode } = sessionBridge

  // Poisoned codes — must release the chain so a reconnect gets a fresh chat.
  assert.equal(isQwenAiPoisonedChatErrorCode('internal_error'), true)
  assert.equal(isQwenAiPoisonedChatErrorCode('managed_tool_result_wrapper_leak'), true)
  assert.equal(isQwenAiPoisonedChatErrorCode('qwen_ai_upstream_http_rejection'), true)

  // Non-poisoned / transient codes — the chain must be RETAINED.
  assert.equal(isQwenAiPoisonedChatErrorCode('CHAT_IN_PROGRESS'), false)
  assert.equal(isQwenAiPoisonedChatErrorCode('qwen_ai_session_stale'), false)
  assert.equal(isQwenAiPoisonedChatErrorCode('qwen_ai_upstream_busy'), false)
  assert.equal(isQwenAiPoisonedChatErrorCode('qwen_ai_capacity_limit'), false)
  assert.equal(isQwenAiPoisonedChatErrorCode(undefined), false)
  assert.equal(isQwenAiPoisonedChatErrorCode(''), false)
})

test('a poisoned chain released via releaseChain lets the next claim mint fresh', () => {
  const registry = new QwenAiStickyRegistry({ idleTtlMs: 60_000 })
  const chainKey = 'chain-poisoned-1'
  registry.registerChain(chainKey, {
    accountId: 'account-a',
    providerId: 'qwen-ai',
    chatId: 'chat-poisoned',
    parentId: 'resp-old',
    historyHash: 'hash-1',
    lastSeenCount: 10,
  })

  // Claim shows the chain bound to the poisoned chat.
  const first = registry.claimByChainKey(chainKey)
  assert.equal(first.status, 'claimed')
  assert.equal(first.entry.chatId, 'chat-poisoned')
  registry.releaseChainClaim(first.claim)

  // The poisoned-chat verdict releases the chain entirely.
  registry.releaseChain(chainKey)

  // The next claim on the same chainKey is 'missing' — the route then
  // registers a fresh chain/chat instead of re-binding to the dead branch.
  const second = registry.claimByChainKey(chainKey)
  assert.equal(second.status, 'missing', 'released chain must not re-bind to the dead chat')
})
