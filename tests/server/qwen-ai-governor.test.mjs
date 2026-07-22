import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function loadGovernorForRuntimeTest(queueTimeoutMs = 1_000, configOverrides = {}) {
  const source = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const storeManager = {
    getConfig: () => ({
      qwenAiGovernorConfig: {
        autoTuneEnabled: false,
        maxConcurrent: 1,
        globalMinIntervalMs: 0,
        accountMinIntervalMs: 0,
        ...configOverrides,
      },
    }),
    getProviders: () => [],
    getAccounts: () => [],
  }
  const calculateQwenAiRequestReadyAt = input => Math.max(
    input.accountActive ? Number.POSITIVE_INFINITY : 0,
    input.lastGlobalStartAt + input.globalMinIntervalMs,
    input.recoveryBypassAccountInterval ? 0 : input.accountNextAvailableAt,
    input.accountCooldownUntil,
  )
  const calculateQwenAiAdaptiveLimits = input => ({
    maxConcurrent: input.configuredMaxConcurrent,
    globalMinIntervalMs: input.configuredGlobalMinIntervalMs,
    autoTuneReason: 'manual',
  })
  const parseQwenAiRetryAfterMs = headers => {
    const value = Object.entries(headers || {})
      .find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined
  }
  const testRequire = specifier => {
    if (specifier === '../store/store') return { storeManager }
    if (specifier === '../store/types') {
      return { normalizeQwenAiGovernorConfig: config => config }
    }
    if (specifier === './qwenAiGovernorPolicy') {
      return { calculateQwenAiAdaptiveLimits, calculateQwenAiRequestReadyAt, parseQwenAiRetryAfterMs }
    }
    throw new Error(`Unexpected governor test import: ${specifier}`)
  }

  const previousQueueTimeout = process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS
  process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS = String(queueTimeoutMs)
  try {
    new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  } finally {
    if (previousQueueTimeout === undefined) {
      delete process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS
    } else {
      process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS = previousQueueTimeout
    }
  }

  return module.exports.QwenAiRequestGovernor
}

test('Qwen AI requests are routed through a per-provider governor', () => {
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const qwenAiForwarderSource = forwarderSource.slice(
    forwarderSource.indexOf('private async forwardQwenAi'),
    forwarderSource.indexOf('/**\n   * Z.ai Dedicated Forward'),
  )

  assert.match(forwarderSource, /qwenAiRequestGovernor/)
  assert.match(forwarderSource, /qwenAiRequestGovernor\.run\(account\.id/)
  assert.match(forwarderSource, /this\.forwardQwenAi\(request, account, provider, actualModel, startTime, context\)/)
  assert.match(forwarderSource, /signal: context\.signal/)
  assert.match(forwarderSource, /CHAT2API_QWEN_AI_RETRY_COUNT/)
  assert.match(forwarderSource, /QwenAiAdapter\.isQwenAiProvider\(provider\)[\s\S]*qwenAiRetryCountFromEnv\(recoverManagedToolStream\)/)
  assert.match(forwarderSource, /previousRecoveryHint === 'managed_tool_stream_validation'/)
  assert.match(forwarderSource, /defaultManagedToolRecoveryOnly/)
  assert.match(forwarderSource, /result\.recoveryHint !== 'managed_tool_stream_validation'/)
  assert.match(forwarderSource, /recoveryBypassUsed = true/)
  assert.match(forwarderSource, /recoveryBypassAccountInterval: options\.qwenAiRecoveryBypassAccountInterval/)
  assert.match(qwenAiForwarderSource, /const retryable = status === 499[\s\S]*status === 504[\s\S]*\? false/)
  assert.match(forwarderSource, /lastHeaders = result\.headers/)
  assert.match(forwarderSource, /headers: lastHeaders/)
  assert.match(forwarderSource, /lastRetryable = result\.retryable/)
  assert.match(forwarderSource, /retryable: lastRetryable/)
  assert.match(qwenAiForwarderSource, /handler\.handleStream\(response\.data, \{\s*signal: context\?\.signal,\s*onFailure: \(\) => cleanupChat\(chatId\),\s*\}\)/)
  assert.match(qwenAiForwarderSource, /handler\.handleNonStream\(response\.data, \{\s*signal: context\?\.signal,\s*\}\)/)

  assert.match(governorSource, /CHAT2API_QWEN_AI_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD/)
  assert.match(governorSource, /maxConcurrent/)
  assert.match(governorSource, /accountNextAvailableAt/)
  assert.match(governorSource, /calculateQwenAiRequestReadyAt/)
  assert.match(governorSource, /recoveryBypassAccountInterval/)
  assert.match(governorSource, /attachRelease\(recordedResult\.stream, releaseStream\)/)
  assert.match(governorSource, /accountActive:/)
  assert.match(governorSource, /nextReadyAt === Number\.POSITIVE_INFINITY/)
  assert.match(governorSource, /parseQwenAiRetryAfterMs/)
  assert.match(governorSource, /http_429_retry_after_/)
  assert.match(governorSource, /createQueueTimeoutResult/)
  assert.match(governorSource, /status: 429/)
  assert.match(governorSource, /'Retry-After'/)
  assert.match(governorSource, /retryable: true/)
})

test('explicit Qwen governor environment settings override persisted values', () => {
  const overrides = {
    CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED: 'true',
    CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT: '20',
    CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS: '1000',
    CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS: '30000',
  }
  const previous = Object.fromEntries(
    Object.keys(overrides).map(key => [key, process.env[key]]),
  )

  Object.assign(process.env, overrides)
  try {
    const Governor = loadGovernorForRuntimeTest(1_000, {
      autoTuneEnabled: false,
      autoTuneMaxConcurrent: 4,
      autoTuneMinGlobalIntervalMs: 8_000,
      accountMinIntervalMs: 120_000,
    })
    const status = new Governor().getStatus([], [])

    assert.equal(status.config.autoTuneEnabled, true)
    assert.equal(status.config.autoTuneMaxConcurrent, 20)
    assert.equal(status.config.autoTuneMinGlobalIntervalMs, 1_000)
    assert.equal(status.config.accountMinIntervalMs, 30_000)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Qwen AI governor removes the queued abort listener and does not cool an account after active abort', async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const controller = new AbortController()
  const started = deferred()
  const upstream = deferred()

  const resultPromise = governor.run('account-1', () => {
    started.resolve()
    return upstream.promise
  }, { signal: controller.signal })

  await started.promise
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)

  controller.abort()
  const result = await resultPromise
  assert.equal(result.status, 499)
  assert.match(result.error, /while Qwen AI request was active/)
  assert.doesNotMatch(result.error, /was queued/)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)

  upstream.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
  await new Promise(resolve => setImmediate(resolve))

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )
  assert.equal(status.accounts[0].governorCooldownInMs, 0)
  assert.equal(status.accounts[0].governorCooldownReason, undefined)
})

test('Qwen AI governor keeps an active slot occupied until an aborted operation settles', async () => {
  const Governor = loadGovernorForRuntimeTest(2_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  const controller = new AbortController()
  const started = deferred()
  const upstream = deferred()
  const first = governor.run('account-1', () => {
    started.resolve()
    return upstream.promise
  }, { signal: controller.signal })

  await started.promise
  controller.abort()
  const cancelled = await first
  assert.equal(cancelled.status, 499)

  let secondStarted = false
  const second = governor.run('account-2', async () => {
    secondStarted = true
    return { success: true, status: 200 }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)

  upstream.resolve({ success: true, status: 200 })
  const secondResult = await second
  assert.equal(secondResult.status, 200)
  assert.equal(secondStarted, true)
})

test('Qwen AI governor preserves cancellation when a global circuit opens', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000)
  const governor = new Governor()
  const activeResult = deferred()
  const activeStarted = deferred()
  const activePromise = governor.run('account-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  })
  await activeStarted.promise

  const controller = new AbortController()
  const queuedPromise = governor.run('account-2', async () => ({
    success: true,
    status: 200,
    body: {},
  }), { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))

  controller.abort()
  governor.openGlobalCooldown(5_000, 'test_global_circuit', 1)
  const result = await queuedPromise

  assert.equal(result.status, 499)
  assert.match(result.error, /while Qwen AI request was queued/)

  activeResult.resolve({ success: true, status: 200, body: {} })
  await activePromise
})

test('Qwen AI governor returns a runtime 429 after the queue deadline', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(1_000)
  const governor = new Governor()
  const activeStarted = deferred()
  const activeResult = deferred()
  const activePromise = governor.run('account-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  })
  await activeStarted.promise

  const queuedController = new AbortController()
  let queuedRequestStarted = false
  const queuedAt = Date.now()
  const result = await governor.run('account-2', async () => {
    queuedRequestStarted = true
    return { success: true, status: 200 }
  }, { signal: queuedController.signal })
  const waitedMs = Date.now() - queuedAt

  assert.equal(queuedRequestStarted, false)
  assert.equal(result.status, 429)
  assert.equal(result.retryable, true)
  assert.equal(result.headers?.['Retry-After'], '1')
  assert.match(result.error, /waited in queue for more than 1s/)
  assert.ok(waitedMs >= 900, `queue deadline fired too early: ${waitedMs}ms`)
  assert.ok(waitedMs < 3_000, `queue deadline fired too late: ${waitedMs}ms`)
  assert.equal(getEventListeners(queuedController.signal, 'abort').length, 0)

  activeResult.resolve({ success: true, status: 200, body: {} })
  await activePromise
})

test('Qwen AI governor admits a request that becomes ready at the queue deadline', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(1_000)
  const governor = new Governor()
  const realDateNow = Date.now
  const fixedNow = realDateNow()
  let requestStarted = false
  let resultPromise

  Date.now = () => fixedNow
  try {
    governor.accountNextAvailableAt.set('account-1', fixedNow + 1_000)
    resultPromise = governor.run('account-1', async () => {
      requestStarted = true
      return { success: true, status: 200, body: {} }
    })
  } finally {
    Date.now = realDateNow
  }

  const result = await resultPromise
  assert.equal(requestStarted, true)
  assert.equal(result.success, true)
  assert.equal(result.status, 200)
})

test('Qwen AI managed-tool recovery is not blocked by the provider failure cooldown', async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    failureCooldownMs: 5_000,
  })
  const governor = new Governor()

  const first = await governor.run('account-1', async () => ({
    success: false,
    status: 502,
    error: 'local tool stream validation failed',
    recoveryHint: 'managed_tool_stream_validation',
  }))
  assert.equal(first.status, 502)

  let recoveryStarted = false
  const recovery = await governor.run('account-1', async () => {
    recoveryStarted = true
    return { success: true, status: 200, body: {} }
  }, { recoveryBypassAccountInterval: true })

  assert.equal(recoveryStarted, true)
  assert.equal(recovery.success, true)
})

test('Qwen AI governor logs queue and active timings per request attempt', async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const messages = []
  const originalConsoleInfo = console.info
  console.info = (...args) => messages.push(args)

  try {
    const result = await governor.run('account-1', async () => ({
      success: true,
      status: 200,
      body: {},
    }), {
      requestId: 'request-1',
      attempt: 2,
    })
    assert.equal(result.success, true)
  } finally {
    console.info = originalConsoleInfo
  }

  const lifecycle = messages
    .filter(args => args[0] === '[QwenAI Governor] lifecycle')
    .map(args => JSON.parse(args[1]))
  const admitted = lifecycle.find(entry => entry.event === 'admitted')
  const released = lifecycle.find(entry => entry.event === 'released')

  assert.equal(admitted.requestId, 'request-1')
  assert.equal(admitted.attempt, 2)
  assert.equal(admitted.queueDepthAtEnqueue, 1)
  assert.ok(admitted.queueWaitMs >= 0)
  assert.equal(released.requestId, 'request-1')
  assert.equal(released.attempt, 2)
  assert.ok(released.activeDurationMs >= 0)
})

test('Qwen AI deferred stream risk failures are reported back to the governor', () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    riskCooldownMs: 5_000,
    maxRiskCooldownMs: 5_000,
    globalRiskThreshold: 2,
  })
  const governor = new Governor()

  governor.reportDeferredFailure('account-1', {
    success: false,
    status: 403,
    error: 'FAIL_SYS_USER_VALIDATE RGV587 challenge',
    errorCode: 'qwen_ai_risk_control',
    retryable: false,
  })

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )
  assert.ok(status.accounts[0].governorCooldownInMs > 4_000)
  assert.equal(status.accounts[0].governorCooldownReason, 'qwen_ai_risk_control')
})

test('Qwen AI governor releases a slot when the returned stream already ended', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const endedStream = Readable.from(['complete'])
  endedStream.resume()
  await once(endedStream, 'end')

  const firstResult = await governor.run('account-1', async () => ({
    success: true,
    status: 200,
    stream: endedStream,
  }))
  assert.equal(firstResult.success, true)
  assert.equal(endedStream.readableEnded, true)

  let secondStarted = false
  const secondResult = await governor.run('account-2', async () => {
    secondStarted = true
    return { success: true, status: 200, body: {} }
  })

  assert.equal(secondStarted, true)
  assert.equal(secondResult.success, true)
  assert.equal(secondResult.status, 200)
})

test('Qwen AI governor allows only one in-flight request per account until stream end', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 2,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const { PassThrough } = await import('node:stream')
  const governor = new Governor()
  const firstStarted = deferred()
  const firstStream = new PassThrough()

  const firstPromise = governor.run('account-1', async () => {
    firstStarted.resolve()
    return { success: true, status: 200, stream: firstStream }
  })
  await firstStarted.promise
  await firstPromise

  let secondStarted = false
  const secondPromise = governor.run('account-1', async () => {
    secondStarted = true
    return { success: true, status: 200 }
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)

  firstStream.resume()
  firstStream.end()
  const secondResult = await secondPromise
  assert.equal(secondResult.success, true)
  assert.equal(secondStarted, true)
})

test('Qwen AI governor honors a bounded Retry-After for ordinary 429 responses', () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  return governor.run('account-1', async () => ({
    success: false,
    status: 429,
    headers: { 'Retry-After': '300' },
    error: 'upstream rate limited',
  })).then(() => {
    const status = governor.getStatus(
      [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
      [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
    )
    assert.ok(status.accounts[0].governorCooldownInMs >= 299_000)
    assert.match(status.accounts[0].governorCooldownReason, /http_429_retry_after/)
  })
})

test('Qwen AI governor adds Retry-After from its configured cooldown when upstream omits it', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    failureCooldownMs: 45_000,
    maxRiskCooldownMs: 120_000,
  })
  const governor = new Governor()
  const result = await governor.run('account-1', async () => ({
    success: false,
    status: 429,
    error: 'upstream capacity limited',
    retryable: false,
  }))

  assert.equal(result.status, 429)
  assert.equal(result.headers?.['Retry-After'], '45')
  assert.equal(result.retryable, false)
})

test('Qwen AI risk-control failures cool the account and require distinct accounts before global circuit', () => {
  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(chatRouteSource, /isQwenAiRiskControl/)
  assert.match(chatRouteSource, /FAIL_SYS_USER_VALIDATE\|RGV587/)
  assert.match(chatRouteSource, /loadBalancer\.markQwenAiRiskControl\(account\.id\)/)

  assert.match(loadBalancerSource, /markAccountCooldown/)
  assert.match(loadBalancerSource, /markQwenAiRiskControl/)
  assert.match(loadBalancerSource, /QWEN_AI_RISK_COOLDOWN/)
  assert.match(loadBalancerSource, /cooldownUntil/)
  assert.match(loadBalancerSource, /isAccountInHardCooldown/)
  assert.match(loadBalancerSource, /filter\(account => !this\.isAccountInHardCooldown\(account\.id\)\)/)
  assert.match(loadBalancerSource, /qwenAiRequestGovernor\.isAccountImmediatelyAvailable\(candidate\.account\.id\)/)

  assert.match(governorSource, /qwen_ai_risk_control/)
  assert.match(governorSource, /2 \*\* \(failures - 1\)/)
  assert.match(governorSource, /recordGlobalRiskControl/)
  assert.match(governorSource, /recordGlobalRiskControl\(accountId, config\)/)
  assert.match(governorSource, /new Set\(this\.riskEvents\.map\(event => event\.accountId\)\)\.size/)
  assert.match(governorSource, /qwen_ai_global_risk_circuit/)
  assert.match(governorSource, /createGlobalCircuitOpenResult/)
  assert.match(governorSource, /reportDeferredFailure/)
  assert.match(governorSource, /Retry-After/)
  assert.match(chatRouteSource, /ctx\.set\(key, value\)/)
  assert.match(chatRouteSource, /qwenAiRequestGovernor\.reportDeferredFailure\(account\.id/)
})

test('Qwen AI governor exposes configurable global risk circuit settings', () => {
  const sharedTypes = fs.readFileSync('src/shared/types.ts', 'utf8')
  const storeTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const configSource = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  const zh = fs.readFileSync('src/renderer/src/i18n/locales/zh-CN.json', 'utf8')

  for (const source of [sharedTypes, storeTypes, panelSource]) {
    assert.match(source, /globalRiskCooldownMs/)
    assert.match(source, /maxGlobalRiskCooldownMs/)
    assert.match(source, /riskWindowMs/)
    assert.match(source, /globalRiskThreshold/)
  }

  assert.match(sharedTypes, /globalCooldownInMs/)
  assert.match(sharedTypes, /recentRiskEvents/)
  assert.match(sharedTypes, /recentRiskAccounts/)
  assert.match(storeTypes, /globalMinIntervalMs:\s*15000/)
  assert.match(storeTypes, /accountMinIntervalMs:\s*120000/)
  assert.match(storeTypes, /globalRiskCooldownMs:\s*30 \* 60 \* 1000/)
  assert.match(storeTypes, /globalRiskThreshold:\s*3/)
  assert.match(configSource, /maxGlobalRiskCooldownMs must be greater than or equal to globalRiskCooldownMs/)
  assert.match(zh, /全局风控熔断/)
})

test('Qwen AI governor auto-tunes effective rate limits from healthy accounts and risk events', () => {
  const sharedTypes = fs.readFileSync('src/shared/types.ts', 'utf8')
  const storeTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const configSource = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  const en = fs.readFileSync('src/renderer/src/i18n/locales/en-US.json', 'utf8')

  for (const source of [sharedTypes, storeTypes]) {
    assert.match(source, /autoTuneEnabled/)
    assert.match(source, /autoTuneMaxConcurrent/)
    assert.match(source, /autoTuneMinGlobalIntervalMs/)
  }

  assert.match(sharedTypes, /QwenAiGovernorEffectiveConfig/)
  assert.match(sharedTypes, /effectiveConfig: QwenAiGovernorEffectiveConfig/)
  assert.match(storeTypes, /autoTuneEnabled:\s*true/)
  assert.match(storeTypes, /autoTuneMaxConcurrent:\s*(?:MAX_QWEN_AI_CONCURRENCY|100)/)
  assert.match(storeTypes, /autoTuneMinGlobalIntervalMs:\s*(?:1000|8000)/)
  assert.match(configSource, /qwenAiGovernorConfig\.autoTuneEnabled must be a boolean/)
  assert.match(governorSource, /calculateEffectiveConfig/)
  assert.match(governorSource, /calculateQwenAiAdaptiveLimits/)
  assert.match(governorSource, /healthyAccountCount: options\.healthyAccountCount/)
  assert.match(governorSource, /recentRiskEvents: options\.recentRiskEvents/)
  assert.match(governorSource, /effectiveConfig/)
  assert.match(panelSource, /qwen-auto-tune/)
  assert.match(panelSource, /status\?\.effectiveConfig\.maxConcurrent/)
  assert.match(panelSource, /autoTuneMaxConcurrent/)
  assert.match(en, /Auto tuning/)
})

test('Qwen AI cancellation and timeout paths are not retried or logged as success', () => {
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const qwenAiSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const proxyTypes = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(proxyTypes, /retryable\?: boolean/)
  assert.match(forwarderSource, /context\.signal\?\.aborted/)
  assert.match(forwarderSource, /isClientCancellationError\(error\)/)
  const errorsSource = fs.readFileSync('src/main/proxy/utils/errors.ts', 'utf8')
  assert.match(errorsSource, /name === 'CanceledError'/)
  assert.match(errorsSource, /code === 'ERR_CANCELED'/)
  assert.match(forwarderSource, /timed out\|timeout\|idle for more than/)
  assert.match(governorSource, /destroyForwardStream/)
  assert.match(governorSource, /candidate\.destroy\(\)/)
  assert.doesNotMatch(governorSource, /candidate\.destroy\(new Error/)
  assert.match(governorSource, /item\.cancelled \|\| item\.signal\?\.aborted/)
  assert.match(governorSource, /Client disconnected while Qwen AI request was active/)
  assert.match(qwenAiSource, /options\.signal\?\.aborted/)
  assert.match(qwenAiSource, /Qwen AI response stream aborted before reading started/)
  assert.match(qwenAiSource, /QWEN_AI_STREAM_FAILURE_EVENT/)
  assert.match(qwenAiSource, /transStream\.qwenAiFailure = error/)
  assert.match(qwenAiSource, /stream\.once\('error', \(err: Error\) => \{\s*if \(finalChunkSent\) \{\s*return/)
  assert.match(forwarderSource, /retryable = status === 499[\s\S]*status === 403[\s\S]*status === 429[\s\S]*status === 504[\s\S]*\? false/)

  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  assert.match(chatRouteSource, /deferStreamOutcome/)
  assert.match(chatRouteSource, /QWEN_AI_STREAM_FAILURE_EVENT/)
  assert.match(chatRouteSource, /streamFailureStatus/)
  assert.match(chatRouteSource, /recordDeferredStreamOutcome\(!qwenAiFailure, qwenAiFailure\)/)
  assert.match(chatRouteSource, /ctx\.res\.once\('close',[\s\S]*!ctx\.res\.writableEnded/)
  assert.match(governorSource, /queueAbortListener/)
  assert.match(governorSource, /removeEventListener\('abort', item\.queueAbortListener\)/)
  assert.match(governorSource, /settledByAbort \|\| item\.signal\?\.aborted \|\| item\.cancelled/)
  assert.match(governorSource, /item\.cancelled = true\s*\n\s*this\.clearQueueItemWaiters\(item\)/)

  const geminiRouteSource = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')
  assert.match(geminiRouteSource, /ctx\.res\.once\('close',[\s\S]*!ctx\.res\.writableEnded/)
})

test('Qwen AI production logs avoid dumping full prompts by default', () => {
  const qwenAiSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(qwenAiSource, /CHAT2API_QWEN_AI_DEBUG_PAYLOADS/)
  assert.match(qwenAiSource, /CHAT2API_QWEN_AI_DEBUG_STREAM/)
  assert.match(qwenAiSource, /summarizePayloadForLog/)
  assert.match(qwenAiSource, /Request payload summary/)
  assert.match(qwenAiSource, /contentChars/)
  assert.match(qwenAiSource, /fileCount/)
  assert.match(qwenAiSource, /if \(QWEN_AI_DEBUG_PAYLOAD_LOGS\)/)
  assert.match(qwenAiSource, /if \(QWEN_AI_DEBUG_STREAM_LOGS\)/)
})
