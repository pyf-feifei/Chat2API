import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function loadRepairModule({ accounts, providers, repairWebSession, refreshAfterUnauthorized, gateRemainingMs = 0 }) {
  const source = fs.readFileSync('src/main/proxy/qwenAiSessionRepair.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const logs = []
  const localModules = {
    '../store/store': {
      storeManager: {
        getProviders: () => providers,
        getAccounts: () => accounts,
        addLog: (...args) => logs.push(args),
      },
    },
    './adapters/qwen-ai-token-refresh': {
      hasQwenAiSessionCookie: cookies => /(?:^|;\s*)token=[^;]+/.test(String(cookies || '')),
      qwenAiRefreshRiskGateRemainingMs: () => gateRemainingMs,
      qwenAiTokenRefresher: {
        repairWebSession,
        refreshAfterUnauthorized: refreshAfterUnauthorized || repairWebSession,
      },
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier === './webshareProxy' || specifier === '../webshareProxy') {
      return {
        isWebshareProxyEnabled: () => false,
        isWebshareStickyActive: () => false,
        maybeProbeWebshareDirectExit: () => {},
        engageWebshareStickyMode: () => {},
        disengageWebshareStickyMode: () => {},
        reportWebshareProxyFailure: () => {},
        reportWebshareProxySuccess: () => {},
        getWebshareProxyAgent: () => undefined,
        webshareProxyUrlForLog: () => undefined,
      }
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
    throw new Error(`Unexpected Qwen session repair test import: ${specifier}`)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return { ...module.exports, logs }
}

function account(id, credentials, status = 'active') {
  return {
    id,
    providerId: 'qwen-ai',
    name: id,
    status,
    credentials,
  }
}
const provider = {
  id: 'qwen-ai',
  name: 'Qwen AI',
  apiEndpoint: 'https://chat.qwen.ai',
}

test('Qwen AI session repair selects one repairable incomplete account and makes it ready', async () => {
  const ready = account('ready', {
    token: 'jwt-ready',
    cookies: 'token=session-ready; x-ap=value',
  })
  const incomplete = account('incomplete', {
    token: 'jwt-incomplete',
    cookies: 'cnaui=value; x-ap=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  const missingLogin = account('missing-login', {
    token: 'jwt-only',
    cookies: 'cnaui=value',
  })
  const calls = []
  const loaded = loadRepairModule({
    accounts: [ready, incomplete, missingLogin],
    providers: [provider],
    repairWebSession: async selected => {
      calls.push(selected.id)
      return {
        ...selected,
        credentials: {
          ...selected.credentials,
          cookies: `${selected.credentials.cookies}; token=repaired-session`,
        },
      }
    },
  })
  const service = new loaded.QwenAiSessionRepairService()

  const result = await service.repairNext()

  assert.deepEqual(calls, ['incomplete'])
  assert.deepEqual(result, { status: 'repaired', accountId: 'incomplete' })
  const repairedAccount = {
    ...incomplete,
    credentials: {
      ...incomplete.credentials,
      cookies: `${incomplete.credentials.cookies}; token=repaired-session`,
    },
  }
  assert.equal(service.getAccountStatus(repairedAccount).state, 'ready')
  assert.equal(service.getAccountStatus(missingLogin).state, 'unrepairable')
  assert.equal(loaded.logs[0][0], 'info')
})

test('Qwen AI session repair pauses the account sweep after upstream risk control', async () => {
  const incomplete = account('risk-controlled', {
    token: 'jwt-incomplete',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  let calls = 0
  const loaded = loadRepairModule({
    accounts: [incomplete],
    providers: [provider],
    repairWebSession: async () => {
      calls += 1
      throw Object.assign(new Error('Qwen AI token refresh failed (risk-control)'), {
        status: 403,
        code: 'qwen_ai_token_refresh_failed',
        accountFault: false,
      })
    },
  })
  const service = new loaded.QwenAiSessionRepairService()

  const failed = await service.repairNext()
  const paused = await service.repairNext()

  assert.equal(failed.status, 'failed')
  assert.equal(failed.accountId, 'risk-controlled')
  assert.ok(failed.globalPauseUntil > Date.now())
  assert.deepEqual(paused, {
    status: 'paused',
    nextAttemptAt: failed.globalPauseUntil,
  })
  assert.equal(calls, 1)
  assert.equal(service.getAccountStatus(incomplete).state, 'backoff')
})

test('Qwen AI session repair does not burn accounts while the refresh endpoint is gated', async () => {
  const incomplete = account('gated-candidate', {
    token: 'jwt-incomplete',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  let calls = 0
  const loaded = loadRepairModule({
    accounts: [incomplete],
    providers: [provider],
    gateRemainingMs: 240_000,
    repairWebSession: async () => {
      calls += 1
      throw new Error('must not be reached')
    },
  })
  const service = new loaded.QwenAiSessionRepairService()

  const first = await service.repairNext()
  const second = await service.repairNext()

  assert.equal(first.status, 'paused')
  assert.equal(second.status, 'paused')
  assert.ok(first.nextAttemptAt > Date.now())
  // No network call and, critically, no per-account failure: the upstream
  // never judged this credential.
  assert.equal(calls, 0)
  assert.deepEqual(loaded.logs, [])
  // The account is only waiting on the shared pause, which is the whole point
  // of a pause: it carries no account-level verdict of its own.
  const status = service.getAccountStatus(incomplete)
  assert.equal(status.state, 'backoff')
  assert.equal(status.nextAttemptAt, first.nextAttemptAt)
})

test('Qwen AI session repair does not blame an account for a local gate rejection', async () => {
  const incomplete = account('gated-error', {
    token: 'jwt-incomplete',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  const loaded = loadRepairModule({
    accounts: [incomplete],
    providers: [provider],
    repairWebSession: async () => {
      throw Object.assign(new Error('Qwen AI token refresh skipped: egress is under risk-control'), {
        status: 403,
        code: 'qwen_ai_token_refresh_gated',
        retryable: false,
        accountFault: false,
      })
    },
  })
  const service = new loaded.QwenAiSessionRepairService()

  const result = await service.repairNext()

  assert.equal(result.status, 'paused')
  // The account must carry no account-level verdict: only the shared pause is
  // set. A recorded failure would push nextAttemptAt past it, because the
  // failure backoff is 5 minutes while the risk cooldown is 3.
  const status = service.getAccountStatus(incomplete)
  assert.equal(status.state, 'backoff')
  assert.ok(status.nextAttemptAt <= service.getRuntimeStatus().globalPauseUntil)
  assert.deepEqual(loaded.logs, [])
})

test('Qwen AI session repair re-probes a frozen account instead of parking it forever', async () => {
  const frozen = account('frozen', {
    token: 'jwt-frozen',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  }, 'inactive')
  // Frozen long enough ago that the re-probe deadline has already passed.
  frozen.updatedAt = Date.now() - 24 * 60 * 60 * 1000
  const probes = []
  const repairs = []
  const loaded = loadRepairModule({
    accounts: [frozen],
    providers: [provider],
    // A probe must re-authenticate: the frozen account may still hold its
    // session cookie, which makes a plain repair a no-op.
    refreshAfterUnauthorized: async selected => {
      probes.push(selected.id)
      return {
        ...selected,
        status: 'active',
        credentials: {
          ...selected.credentials,
          cookies: `${selected.credentials.cookies}; token=recovered-session`,
        },
      }
    },
    repairWebSession: async selected => {
      repairs.push(selected.id)
      return selected
    },
  })

  const service = new loaded.QwenAiSessionRepairService()

  // A repairable frozen account is probe-eligible, not unrepairable.
  const dueStatus = service.getAccountStatus(frozen)
  assert.equal(dueStatus.state, 'probe')
  assert.equal(dueStatus.repairable, true)
  assert.equal(dueStatus.nextAttemptAt, undefined)

  const result = await service.repairNext()

  assert.deepEqual(probes, ['frozen'])
  assert.deepEqual(repairs, [], 'a frozen account must not take the no-op repair path')
  assert.equal(result.status, 'repaired')
  const recovered = {
    ...frozen,
    status: 'active',
    credentials: { ...frozen.credentials, cookies: 'cnaui=value; token=recovered-session' },
  }
  assert.equal(service.getAccountStatus(recovered).state, 'ready')
})

test('Qwen AI session repair fails a probe that does not reactivate the account', async () => {
  const frozen = account('stuck', {
    token: 'jwt-frozen',
    cookies: 'cnaui=value; token=still-there',
    email: 'fixture@example.test',
    password: 'fixture-password',
  }, 'inactive')
  frozen.updatedAt = Date.now() - 24 * 60 * 60 * 1000
  const loaded = loadRepairModule({
    accounts: [frozen],
    providers: [provider],
    // Signin answered, but the account never came back to the pool.
    refreshAfterUnauthorized: async selected => ({ ...selected }),
    repairWebSession: async selected => selected,
  })

  const service = new loaded.QwenAiSessionRepairService()
  const result = await service.repairNext()

  assert.equal(result.status, 'failed')
  assert.ok(service.getAccountStatus(frozen).nextAttemptAt > Date.now())
})

test('Qwen AI session repair holds a frozen account until its re-probe deadline', async () => {
  const frozen = account('recently-frozen', {
    token: 'jwt-frozen',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  }, 'inactive')
  frozen.updatedAt = Date.now()
  let calls = 0
  const loaded = loadRepairModule({
    accounts: [frozen],
    providers: [provider],
    repairWebSession: async () => {
      calls += 1
      throw new Error('unexpected refresh')
    },
  })

  const service = new loaded.QwenAiSessionRepairService()
  const status = service.getAccountStatus(frozen)

  assert.equal(status.state, 'probe')
  assert.ok(status.nextAttemptAt > Date.now())
  assert.deepEqual(await service.repairNext(), {
    status: 'idle',
    nextAttemptAt: status.nextAttemptAt,
  })
  assert.equal(calls, 0)
})

test('Qwen AI session repair still reports a frozen account without login as unrepairable', async () => {
  const noLogin = account('no-login', {
    token: 'jwt-only',
    cookies: 'cnaui=value',
  }, 'inactive')
  const loaded = loadRepairModule({
    accounts: [noLogin],
    providers: [provider],
    repairWebSession: async () => {
      throw new Error('unexpected refresh')
    },
  })

  const service = new loaded.QwenAiSessionRepairService()

  assert.equal(service.getAccountStatus(noLogin).state, 'unrepairable')
  assert.deepEqual(await service.repairNext(), { status: 'idle' })
})

test('Qwen AI repair is wired into server lifecycle, validation, and governor status', () => {
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')
  const accountsSource = fs.readFileSync('src/main/store/accounts.ts', 'utf8')
  const governorRouteSource = fs.readFileSync(
    'src/main/proxy/routes/management/qwenAiGovernor.ts',
    'utf8',
  )

  assert.match(serverSource, /qwenAiSessionRepairService\.start\(\)/)
  assert.match(serverSource, /qwenAiSessionRepairService\.stop\(\)/)
  assert.match(accountsSource, /qwenAiTokenRefresher\.repairWebSession\(account\)/)
  assert.match(accountsSource, /validateCredentials\(provider, validationAccount\.credentials\)/)
  assert.match(governorRouteSource, /storeManager\.getAccounts\(true\)/)
  assert.match(governorRouteSource, /webSessionRepairState: repairStatus\.state/)
})
