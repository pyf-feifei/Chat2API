import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)

/**
 * Regression cover for the 2026-09-22 local outage: one upstream/egress
 * rejection verdict persisted 340 healthy Qwen accounts as `inactive`, and
 * because the session-repair queue only accepted `active` accounts the
 * refresher could never undo its own verdict. Qwen stayed dark for days while
 * the very same credentials signed in successfully when retried by hand.
 */
function loadTokenRefreshModule({ post, updateAccount, env = {} } = {}) {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const previousEnv = {}
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const axios = {
    post: post || (async () => {
      throw new Error('Unexpected Qwen AI signin request')
    }),
  }
  const localModules = {
    axios,
    crypto: runtimeRequire('node:crypto'),
    '../../store/store': {
      storeManager: {
        updateAccount: updateAccount || (() => null),
      },
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier === './services/retrievalTool' || specifier === './services/retrievalTool.ts') {
      return { stripRetrievalTool: tools => tools, extractArchiveHashes: () => [] }
    }
    if (specifier === './services/retrievalSettings' || specifier === './services/retrievalSettings.ts') {
      return { getRetrievalSettings: () => ({ enabled: false, maxRetrievalsPerRequest: 4 }), nonNegativeEnv: (_k, d) => d }
    }
    if (specifier === './services/retrievalLoop' || specifier === './services/retrievalLoop.ts') {
      return { runWithRetrievalLoop: async ({ attempt, baseRequest }) => ({ response: await attempt(baseRequest), turns: 0, resolved: [] }) }
    }
    if (specifier === './services/compressionArchive' || specifier === './services/compressionArchive.ts') {
      return { CompressionArchive: class { constructor() { this.records = new Map() } record() { return undefined } resolve() { return undefined } forget() {} stats() { return { entries: 0, chars: 0, maxChars: 0, ttlMs: 0 } } }, buildScope: (p, a, c) => [p, a, c || 'req'].join(':') }
    }
    if (specifier === './toolCalling/localToolCalls' || specifier === './toolCalling/localToolCalls.ts') {
      return { partitionLocalToolCalls: ({ toolCalls }) => ({ clientCalls: toolCalls, local: [] }), runWithLocalToolContext: (_c, fn) => fn(), getLocalToolContext: () => undefined }
    }
    if (specifier === '../runtime/index' || specifier === '../runtime/index.ts') {
      return { getRuntime: () => ({ getDataDir: () => process.cwd(), getResourcePath: (f) => f, kind: 'node' }) }
    }
    throw new Error(`Unexpected token refresher test import: ${specifier}`)
  }

  try {
    new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  } catch (error) {
    restoreEnv()
    throw error
  }

  // The module reads its tuning knobs lazily, so the overrides must stay in
  // place for the whole test; callers release them through `__restoreEnv`.
  return { ...module.exports, __restoreEnv: restoreEnv }
}

function jwtExpiringAt(timestampMs) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(timestampMs / 1000) })}.signature`
}

function qwenAccount(id, overrides = {}) {
  return {
    id,
    providerId: 'qwen-ai',
    name: id,
    status: 'active',
    createdAt: 1,
    updatedAt: Date.now(),
    credentials: {
      token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
      cookies: 'cnaui=auxiliary-cookie',
      email: 'fixture@example.test',
      password: 'fixture-password',
    },
    ...overrides,
  }
}

const UNREGISTERED_BODY = {
  status: 401,
  data: { data: { details: '您提供的帐户未注册。请先注册！' } },
  headers: {},
}

function createPersistedStore() {
  const persisted = []
  const store = { accounts: new Map() }
  store.updateAccount = (id, updates) => {
    persisted.push({ id, updates })
    const existing = store.accounts.get(id) || {}
    const next = { ...existing, ...updates }
    store.accounts.set(id, next)
    return next
  }
  return { store, persisted }
}

test('Qwen AI keeps a healthy account out of the frozen pool on a single rejection verdict', async () => {
  const { store, persisted } = createPersistedStore()
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    post: async () => UNREGISTERED_BODY,
  })
  const account = qwenAccount('single-verdict')

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(account),
    error => error.accountFault === true && error.retryScope === 'next-account',
  )

  const [first] = persisted
  assert.equal(first.updates.status, undefined, 'one verdict must not freeze the account')
  assert.equal(first.updates.unregisteredStrikes, 1)
  assert.ok(first.updates.lastUnregisteredAt >= first.updates.firstUnregisteredAt)
})

test('Qwen AI freezes an account only after repeated unregistered verdicts', async () => {
  const { store, persisted } = createPersistedStore()
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    post: async () => UNREGISTERED_BODY,
  })
  const account = qwenAccount('confirmed-unregistered')
  const refresher = new QwenAiTokenRefresher()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(refresher.refreshIfNeeded(account))
    // Feed the persisted counters back, exactly like a store reload does.
    Object.assign(account, store.accounts.get('confirmed-unregistered'))
  }

  assert.deepEqual(
    persisted.map(entry => entry.updates.unregisteredStrikes),
    [1, 2, 3],
  )
  assert.equal(persisted[0].updates.status, undefined)
  assert.equal(persisted[1].updates.status, undefined)
  assert.equal(persisted[2].updates.status, 'inactive')
})

test('Qwen AI restarts the strike window so an old verdict cannot accumulate into a freeze', async t => {
  const { store, persisted } = createPersistedStore()
  const loaded = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    env: { CHAT2API_QWEN_AI_UNREGISTERED_STRIKE_WINDOW_MS: 60000 },
    post: async () => UNREGISTERED_BODY,
  })
  t.after(loaded.__restoreEnv)
  const { QwenAiTokenRefresher } = loaded
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const account = qwenAccount('stale-strikes', {
    unregisteredStrikes: 2,
    firstUnregisteredAt: twoHoursAgo,
    lastUnregisteredAt: twoHoursAgo,
  })

  await assert.rejects(new QwenAiTokenRefresher().refreshIfNeeded(account))

  const [entry] = persisted
  assert.equal(entry.updates.unregisteredStrikes, 1)
  assert.equal(entry.updates.status, undefined)
  assert.ok(entry.updates.firstUnregisteredAt > twoHoursAgo)
})

test('Qwen AI honours a configured single-strike policy for deployments that want it', async t => {
  const { store, persisted } = createPersistedStore()
  const loaded = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    env: { CHAT2API_QWEN_AI_UNREGISTERED_STRIKES: 1 },
    post: async () => UNREGISTERED_BODY,
  })
  t.after(loaded.__restoreEnv)
  const { QwenAiTokenRefresher } = loaded

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(qwenAccount('opt-in-single-strike')),
  )

  assert.equal(persisted[0].updates.status, 'inactive')
})

test('Qwen AI clears the strike counters after a healthy signin', async () => {
  const { store, persisted } = createPersistedStore()
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    post: async () => ({
      status: 200,
      data: { data: { token: jwtExpiringAt(Date.now() + 60 * 60 * 1000) } },
      headers: { 'set-cookie': ['token=fresh-session; Path=/'] },
    }),
  })
  const account = qwenAccount('recovered', {
    status: 'inactive',
    unregisteredStrikes: 2,
    firstUnregisteredAt: Date.now() - 1000,
    lastUnregisteredAt: Date.now() - 1000,
  })

  const refreshed = await new QwenAiTokenRefresher().refreshIfNeeded(account)

  assert.equal(refreshed.status, 'active')
  assert.equal(refreshed.unregisteredStrikes, 0)
  assert.equal(refreshed.firstUnregisteredAt, undefined)
  assert.equal(refreshed.lastUnregisteredAt, undefined)
  assert.match(refreshed.credentials.cookies, /token=fresh-session/)
  assert.equal(persisted.at(-1).updates.status, 'active')
})

test('Qwen AI does not treat a bare lookup miss as a dead account', async () => {
  const { store, persisted } = createPersistedStore()
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    // The exact shape the 2026-09-22 storm returned for 340 healthy accounts.
    post: async () => ({
      status: 401,
      data: { success: false, message: 'email not found' },
      headers: { 'content-type': 'application/json' },
    }),
  })

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(qwenAccount('lookup-miss')),
    error => error.status === 401
      && error.accountFault === true
      && error.retryScope === 'next-account'
      && error.unregistered !== true
      && !/not registered/.test(error.message),
  )

  assert.equal(persisted.length, 0, 'a lookup miss must not be persisted at all')
})

test('Qwen AI still recognizes explicit absence codes and wording as unregistered', async () => {
  const bodies = [
    { status: 401, data: { code: 'USER_NOT_FOUND' }, headers: {} },
    { status: 401, data: { data: { details: 'account is not registered' } }, headers: {} },
    { status: 401, data: { message: '该邮箱不存在' }, headers: {} },
    { status: 401, data: { message: 'email is not registered' }, headers: {} },
  ]

  for (const body of bodies) {
    const { store, persisted } = createPersistedStore()
    const { QwenAiTokenRefresher } = loadTokenRefreshModule({
      updateAccount: store.updateAccount,
      post: async () => body,
    })

    await assert.rejects(
      new QwenAiTokenRefresher().refreshIfNeeded(qwenAccount('explicit-absence')),
      error => error.unregistered === true && /not registered/.test(error.message),
    )
    assert.equal(persisted[0].updates.unregisteredStrikes, 1, JSON.stringify(body.data))
  }
})

test('Qwen AI opens the shared refresh gate on a cross-account rejection storm', async t => {
  const { store } = createPersistedStore()
  let calls = 0
  const loaded = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    env: { CHAT2API_QWEN_AI_REFRESH_REJECTION_STREAK_LIMIT: 5 },
    post: async () => {
      calls += 1
      return UNREGISTERED_BODY
    },
  })
  t.after(loaded.__restoreEnv)
  const { QwenAiTokenRefresher, getQwenAiRefreshFaultStatus } = loaded
  const refresher = new QwenAiTokenRefresher()

  let stormError
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      refresher.refreshIfNeeded(qwenAccount(`storm-${index}`)),
      error => {
        stormError = error
        return true
      },
    )
  }

  assert.equal(calls, 5)
  assert.equal(stormError.code, 'qwen_ai_token_refresh_rejected_storm')
  assert.match(stormError.message, /5 consecutive credential rejections/)
  assert.ok(getQwenAiRefreshFaultStatus().riskGateRemainingMs > 0)

  // The gate stops the sweep locally: no further egress requests are made.
  await assert.rejects(
    refresher.refreshIfNeeded(qwenAccount('storm-6')),
    error => error.code === 'qwen_ai_token_refresh_gated' && error.accountFault === false,
  )
  assert.equal(calls, 5, 'the gated sweep must not touch the network')
})

test('Qwen AI keeps a lone bad account from tripping the rejection storm gate', async t => {
  const { store } = createPersistedStore()
  const loaded = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    env: { CHAT2API_QWEN_AI_REFRESH_REJECTION_STREAK_LIMIT: 5 },
    post: async () => UNREGISTERED_BODY,
  })
  t.after(loaded.__restoreEnv)
  const { QwenAiTokenRefresher, getQwenAiRefreshFaultStatus } = loaded

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(qwenAccount('genuinely-dead')),
    error => error.code === 'qwen_ai_token_refresh_failed',
  )

  assert.equal(getQwenAiRefreshFaultStatus().riskGateRemainingMs, 0)
  assert.equal(getQwenAiRefreshFaultStatus().rejectionStreak, 1)
})

test('Qwen AI risk-control verdicts do not count toward the rejection storm', async t => {
  const { store } = createPersistedStore()
  const loaded = loadTokenRefreshModule({
    updateAccount: store.updateAccount,
    env: { CHAT2API_QWEN_AI_REFRESH_REJECTION_STREAK_LIMIT: 3 },
    post: async () => ({
      status: 403,
      data: '<meta name="aliyun_waf_aa"> FAIL_SYS_USER_VALIDATE challenge',
      headers: {},
    }),
  })
  t.after(loaded.__restoreEnv)
  const { QwenAiTokenRefresher, getQwenAiRefreshFaultStatus } = loaded
  const refresher = new QwenAiTokenRefresher()

  // WAF hits open the existing risk gate themselves, so the streak stays clean
  // and the account-fault storm counter is not polluted by egress challenges.
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(refresher.refreshIfNeeded(qwenAccount(`waf-${index}`)))
  }

  assert.equal(getQwenAiRefreshFaultStatus().rejectionStreak, 0)
})

test('Qwen AI session repair exposes the frozen-pool probe schedule', () => {
  const source = fs.readFileSync('src/main/proxy/qwenAiSessionRepair.ts', 'utf8')

  assert.match(source, /CHAT2API_QWEN_AI_SESSION_REPAIR_PROBE_INTERVAL_MS/)
  assert.match(source, /'probe'/)
  // The old contract parked every non-active account as unrepairable.
  assert.doesNotMatch(
    source,
    /if \(account\.status !== 'active'\) \{\s*return \{ state: 'unrepairable'/,
  )
})
