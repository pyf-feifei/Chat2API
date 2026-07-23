import type { ForwardResult } from './types'
import { storeManager } from '../store/store'
import type {
  Account,
  AccountStatus,
  Provider,
  QwenAiGovernorConfig,
} from '../store/types'
import { normalizeQwenAiGovernorConfig } from '../store/types'
import type { QwenAiGovernorEffectiveConfig, QwenAiGovernorStatus } from '../../shared/types'
import {
  calculateQwenAiAdaptiveLimits,
  calculateQwenAiRequestReadyAt,
  parseQwenAiRetryAfterMs,
} from './qwenAiGovernorPolicy'

type QueueItem = {
  id: string
  accountId: string
  run: () => Promise<ForwardResult>
  resolve: (value: ForwardResult) => void
  reject: (reason: unknown) => void
  enqueuedAt: number
  queueDepthAtEnqueue: number
  timeout?: NodeJS.Timeout
  signal?: AbortSignal
  queueAbortListener?: () => void
  recoveryBypassAccountInterval: boolean
  requestId?: string
  attempt: number
  cancelled: boolean
}

type QwenAiGovernorRunOptions = {
  signal?: AbortSignal
  recoveryBypassAccountInterval?: boolean
  requestId?: string
  attempt?: number
}

type CooldownState = {
  until: number
  failures: number
  reason: string
}

type RiskEvent = {
  accountId: string
  timestamp: number
}

function withRetryAfterHeader(result: ForwardResult, cooldownMs: number): ForwardResult {
  const hasRetryAfter = Object.keys(result.headers || {})
    .some(key => key.toLowerCase() === 'retry-after')
  if (hasRetryAfter) return result

  return {
    ...result,
    headers: {
      ...(result.headers || {}),
      'Retry-After': String(Math.max(1, Math.ceil(cooldownMs / 1000))),
    },
  }
}

const ENV_DEFAULT_CONFIG: QwenAiGovernorConfig = {
  autoTuneEnabled: process.env.CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED !== 'false',
  autoTuneMaxConcurrent: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT', 100)),
  autoTuneMinGlobalIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS', 1000),
  maxConcurrent: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_MAX_CONCURRENT', 1)),
  globalMinIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS', 15000),
  accountMinIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS', 120000),
  riskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_RISK_COOLDOWN_MS', 10 * 60 * 1000),
  maxRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_MAX_RISK_COOLDOWN_MS', 30 * 60 * 1000),
  failureCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_FAILURE_COOLDOWN_MS', 2 * 60 * 1000),
  globalRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS', 30 * 60 * 1000),
  maxGlobalRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_MAX_GLOBAL_RISK_COOLDOWN_MS', 2 * 60 * 60 * 1000),
  riskWindowMs: numberFromEnv('CHAT2API_QWEN_AI_RISK_WINDOW_MS', 5 * 60 * 1000),
  globalRiskThreshold: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD', 3)),
}

const QWEN_AI_QUEUE_TIMEOUT_MS = Math.max(
  1000,
  numberFromEnv('CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS', 120 * 1000),
)

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function explicitNumberFromEnv(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  if (process.env[name] === undefined) return fallback

  const min = options.min ?? 0
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(min, Math.floor(numberFromEnv(name, fallback))))
}

function explicitBooleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

/**
 * Explicit environment values are deployment-level overrides. This matters
 * for Docker, where persisted defaults otherwise mask changes made in .env.
 */
function applyExplicitEnvironmentOverrides(config: QwenAiGovernorConfig): QwenAiGovernorConfig {
  return normalizeQwenAiGovernorConfig({
    autoTuneEnabled: explicitBooleanFromEnv(
      'CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED',
      config.autoTuneEnabled,
    ),
    autoTuneMaxConcurrent: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT',
      config.autoTuneMaxConcurrent,
      { min: 1, max: 100 },
    ),
    autoTuneMinGlobalIntervalMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS',
      config.autoTuneMinGlobalIntervalMs,
    ),
    maxConcurrent: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_MAX_CONCURRENT',
      config.maxConcurrent,
      { min: 1, max: 100 },
    ),
    globalMinIntervalMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS',
      config.globalMinIntervalMs,
    ),
    accountMinIntervalMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS',
      config.accountMinIntervalMs,
    ),
    riskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_RISK_COOLDOWN_MS',
      config.riskCooldownMs,
    ),
    maxRiskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_MAX_RISK_COOLDOWN_MS',
      config.maxRiskCooldownMs,
    ),
    failureCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_FAILURE_COOLDOWN_MS',
      config.failureCooldownMs,
    ),
    globalRiskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS',
      config.globalRiskCooldownMs,
    ),
    maxGlobalRiskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_MAX_GLOBAL_RISK_COOLDOWN_MS',
      config.maxGlobalRiskCooldownMs,
    ),
    riskWindowMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_RISK_WINDOW_MS',
      config.riskWindowMs,
      { min: 1000 },
    ),
    globalRiskThreshold: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD',
      config.globalRiskThreshold,
      { min: 1, max: 100 },
    ),
  })
}

function isQwenRiskControl(error?: string, status?: number, errorCode?: string): boolean {
  const riskText = `${error || ''} ${errorCode || ''}`
  return Boolean(
    errorCode === 'qwen_ai_risk_control' ||
    ((status === 403 || status === 429) &&
      /qwen_ai_risk_control|FAIL_SYS_USER_VALIDATE|RGV587|bxpunish|risk-control|challenge|x5sec|baxia|punish/i.test(riskText)),
  )
}

function isConfiguredActiveStatus(status: AccountStatus): boolean {
  return status === 'active'
}

function attachRelease(stream: NodeJS.ReadableStream, release: () => void): void {
  let released = false
  const releaseOnce = () => {
    if (!released) {
      released = true
      release()
    }
  }

  stream.once('end', releaseOnce)
  stream.once('close', releaseOnce)
  stream.once('error', releaseOnce)

  const state = stream as NodeJS.ReadableStream & {
    readableEnded?: boolean
    destroyed?: boolean
    closed?: boolean
  }
  if (state.readableEnded || state.destroyed || state.closed) {
    releaseOnce()
  }
}

function destroyForwardStream(stream: NodeJS.ReadableStream | undefined): void {
  if (!stream) return

  const candidate = stream as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void
  }
  if (typeof candidate.destroy === 'function') {
    candidate.destroy()
  }
}

export class QwenAiRequestGovernor {
  private queue: QueueItem[] = []
  private active = 0
  private lastGlobalStartAt = 0
  private timer: NodeJS.Timeout | undefined
  private accountNextAvailableAt: Map<string, number> = new Map()
  private accountCooldowns: Map<string, CooldownState> = new Map()
  private activeByAccount: Map<string, number> = new Map()
  private globalCooldown: CooldownState | undefined
  private riskEvents: RiskEvent[] = []
  private nextQueueItemId = 1

  run(accountId: string, run: () => Promise<ForwardResult>, options: QwenAiGovernorRunOptions = {}): Promise<ForwardResult> {
    return new Promise((resolve, reject) => {
      const now = Date.now()
      this.expireGlobalCooldown(now)

      // A request that is already cancelled must never be converted into a
      // capacity or circuit response, even when a global cooldown is active.
      if (options.signal?.aborted) {
        resolve(this.createCancelledResult('Client disconnected before Qwen AI request was queued.'))
        return
      }

      const globalCooldownInMs = this.getGlobalCooldownInMs(now)
      if (globalCooldownInMs > 0) {
        resolve(this.createGlobalCircuitOpenResult(globalCooldownInMs))
        return
      }

      const item: QueueItem = {
        id: String(this.nextQueueItemId++),
        accountId,
        run,
        resolve,
        reject,
        enqueuedAt: now,
        queueDepthAtEnqueue: this.queue.length + 1,
        signal: options.signal,
        recoveryBypassAccountInterval: options.recoveryBypassAccountInterval === true,
        requestId: options.requestId,
        attempt: options.attempt ?? 1,
        cancelled: false,
      }

      const cancelQueued = (result: ForwardResult) => {
        if (item.cancelled) return
        item.cancelled = true
        this.removeQueuedItem(item)
        resolve(result)
      }

      item.timeout = setTimeout(() => {
        this.pump()
        const stillQueued = this.queue.some(candidate => candidate === item || candidate.id === item.id)
        if (!stillQueued || item.cancelled) return

        if (!options.signal?.aborted) {
          this.logLifecycle(item, 'queue_timeout', {
            queueWaitMs: Math.max(0, Date.now() - item.enqueuedAt),
            activeRequests: this.active,
          })
        }
        cancelQueued(options.signal?.aborted
          ? this.createCancelledResult('Client disconnected while Qwen AI request was queued.')
          : this.createQueueTimeoutResult())
      }, QWEN_AI_QUEUE_TIMEOUT_MS)

      item.queueAbortListener = () => {
        cancelQueued(this.createCancelledResult('Client disconnected while Qwen AI request was queued.'))
      }
      options.signal?.addEventListener('abort', item.queueAbortListener, { once: true })

      this.queue.push(item)
      if (options.signal?.aborted) {
        item.queueAbortListener?.()
        return
      }
      this.pump()
    })
  }

  private createCancelledResult(message: string): ForwardResult {
    return {
      success: false,
      status: 499,
      error: message,
      retryable: false,
    }
  }

  private createQueueTimeoutResult(): ForwardResult {
    const retryAfterSeconds = Math.max(1, Math.ceil(QWEN_AI_QUEUE_TIMEOUT_MS / 1000))
    return {
      success: false,
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
      error: `Qwen AI request waited in queue for more than ${retryAfterSeconds}s.`,
      retryable: true,
    }
  }

  private clearQueueItemWaiters(item: QueueItem): void {
    if (item.timeout) {
      clearTimeout(item.timeout)
      item.timeout = undefined
    }
    if (item.queueAbortListener) {
      item.signal?.removeEventListener('abort', item.queueAbortListener)
      item.queueAbortListener = undefined
    }
  }

  private removeQueuedItem(item: QueueItem): void {
    const index = this.queue.findIndex(candidate => candidate === item || candidate.id === item.id)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.pump()
    }
    this.clearQueueItemWaiters(item)
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    const config = this.getEffectiveConfig()
    const nowForGlobal = Date.now()
    this.expireGlobalCooldown(nowForGlobal)
    const globalCooldownInMs = this.getGlobalCooldownInMs(nowForGlobal)
    if (globalCooldownInMs > 0) {
      this.rejectQueuedRequestsForGlobalCircuit(globalCooldownInMs)
      return
    }

    while (this.active < config.maxConcurrent && this.queue.length > 0) {
      const now = Date.now()
      let selectedIndex = -1
      let nextReadyAt = Number.POSITIVE_INFINITY

      for (let index = 0; index < this.queue.length; index += 1) {
        const readyAt = this.getReadyAt(this.queue[index], now)
        if (readyAt <= now) {
          selectedIndex = index
          break
        }
        nextReadyAt = Math.min(nextReadyAt, readyAt)
      }

      if (selectedIndex === -1) {
        if (nextReadyAt === Number.POSITIVE_INFINITY) {
          // Every queued item belongs to an active account. The active
          // stream's release callback will call pump() when it ends.
          return
        }
        const delayMs = Math.max(50, nextReadyAt - now)
        this.timer = setTimeout(() => this.pump(), delayMs)
        return
      }

      const item = this.queue.splice(selectedIndex, 1)[0]
      this.clearQueueItemWaiters(item)
      if (item.cancelled || item.signal?.aborted) {
        item.cancelled = true
        item.resolve(this.createCancelledResult('Client disconnected before Qwen AI request started.'))
        continue
      }
      this.start(item)
    }
  }

  private start(item: QueueItem): void {
    const config = this.getEffectiveConfig()
    const startedAt = Date.now()
    const queueWaitMs = Math.max(0, startedAt - item.enqueuedAt)
    this.active += 1
    this.activeByAccount.set(item.accountId, (this.activeByAccount.get(item.accountId) || 0) + 1)
    this.lastGlobalStartAt = startedAt
    this.accountNextAvailableAt.set(item.accountId, startedAt + config.accountMinIntervalMs)
    this.logLifecycle(item, 'admitted', {
      queueWaitMs,
      activeRequests: this.active,
    })

    let released = false
    let settledByAbort = false
    let runStarted = false
    let activeStream: NodeJS.ReadableStream | undefined
    const release = () => {
      if (!released) {
        released = true
        this.logLifecycle(item, 'released', {
          queueWaitMs,
          activeDurationMs: Math.max(0, Date.now() - startedAt),
          activeRequests: Math.max(0, this.active - 1),
        })
        this.active -= 1
        this.activeByAccount.set(item.accountId, Math.max(0, (this.activeByAccount.get(item.accountId) || 1) - 1))
        this.pump()
      }
    }

    const abortActive = () => {
      if (settledByAbort) return
      settledByAbort = true
      // The caller can stop waiting immediately, but the admission slot must
      // remain occupied until the in-flight operation settles. Releasing it
      // here would allow a second upstream request while token refresh,
      // upload, or chat creation is still running.
      item.signal?.removeEventListener('abort', abortActive)
      if (!runStarted) {
        release()
      } else if (activeStream) {
        destroyForwardStream(activeStream)
      }
      item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
    }

    item.signal?.addEventListener('abort', abortActive, { once: true })
    if (item.signal?.aborted) {
      abortActive()
      return
    }

    runStarted = true
    Promise.resolve()
      .then(() => {
        if (item.signal?.aborted) {
          return this.createCancelledResult('Client disconnected before Qwen AI request started.')
        }
        return item.run()
      })
      .then((result) => {
        if (item.cancelled || item.signal?.aborted) {
          item.signal?.removeEventListener('abort', abortActive)
          activeStream = result.stream
          destroyForwardStream(result.stream)
          release()
          item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
          return
        }

        const recordedResult = this.recordResult(item.accountId, result)
        if (recordedResult.success && recordedResult.stream) {
          activeStream = recordedResult.stream
          const releaseStream = () => {
            item.signal?.removeEventListener('abort', abortActive)
            release()
          }
          attachRelease(recordedResult.stream, releaseStream)
          if (item.signal?.aborted) {
            releaseStream()
          }
        } else {
          item.signal?.removeEventListener('abort', abortActive)
          release()
        }
        item.resolve(recordedResult)
      })
      .catch((error) => {
        item.signal?.removeEventListener('abort', abortActive)
        if (settledByAbort || item.signal?.aborted || item.cancelled) {
          release()
          item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
          return
        }
        const accountFault = (error as { accountFault?: unknown } | undefined)?.accountFault
        if (accountFault !== false) {
          this.openCooldown(item.accountId, this.getConfig().failureCooldownMs, 'exception')
        }
        release()
        item.reject(error)
      })
  }

  private logLifecycle(
    item: QueueItem,
    event: 'queue_timeout' | 'admitted' | 'released',
    metrics: Record<string, number>,
  ): void {
    if (!item.requestId) return

    console.info('[QwenAI Governor] lifecycle', JSON.stringify({
      event,
      requestId: item.requestId,
      accountId: item.accountId,
      attempt: item.attempt,
      queueDepthAtEnqueue: item.queueDepthAtEnqueue,
      ...metrics,
    }))
  }

  private getReadyAt(item: QueueItem, now: number): number {
    const config = this.getEffectiveConfig()
    this.expireCooldown(item.accountId, now)

    return calculateQwenAiRequestReadyAt({
      lastGlobalStartAt: this.lastGlobalStartAt,
      globalMinIntervalMs: config.globalMinIntervalMs,
      accountNextAvailableAt: this.accountNextAvailableAt.get(item.accountId) || 0,
      accountCooldownUntil: this.accountCooldowns.get(item.accountId)?.until || 0,
      recoveryBypassAccountInterval: item.recoveryBypassAccountInterval,
      accountActive: (this.activeByAccount.get(item.accountId) || 0) > 0,
    })
  }

  private recordResult(accountId: string, result: ForwardResult): ForwardResult {
    if (result.success) {
      this.accountCooldowns.delete(accountId)
      return result
    }

    // A managed-tool validation failure is produced by the local response
    // parser, not by Qwen capacity. The forwarder performs one bounded
    // recovery attempt, so opening the normal 5xx cooldown here would make
    // that retry sit behind the queue timeout.
    if (result.recoveryHint === 'managed_tool_stream_validation') {
      return result
    }

    if (result.accountFault === false) {
      return result
    }

    if (isQwenRiskControl(result.error, result.status, result.errorCode)) {
      const config = this.getConfig()
      const current = this.accountCooldowns.get(accountId)
      const failures = (current?.failures || 0) + 1
      const cooldownMs = Math.min(config.riskCooldownMs * (2 ** (failures - 1)), config.maxRiskCooldownMs)
      this.openCooldown(accountId, cooldownMs, 'qwen_ai_risk_control', failures)
      this.recordGlobalRiskControl(accountId, config)
      return result
    }

    if (result.status === 429 || (result.status !== undefined && result.status >= 500)) {
      const config = this.getConfig()
      const retryAfterMs = result.status === 429
        ? parseQwenAiRetryAfterMs(result.headers)
        : undefined
      const maxCooldownMs = Math.max(config.failureCooldownMs, config.maxRiskCooldownMs)
      const cooldownMs = Math.min(
        maxCooldownMs,
        Math.max(config.failureCooldownMs, retryAfterMs ?? 0),
      )
      const reason = result.status === 429 && retryAfterMs !== undefined
        ? `http_429_retry_after_${Math.ceil(cooldownMs / 1000)}s`
        : `http_${result.status}`
      this.openCooldown(accountId, cooldownMs, reason)
      if (result.status === 429) {
        return withRetryAfterHeader(result, cooldownMs)
      }
    }

    return result
  }

  reportDeferredFailure(accountId: string, result: ForwardResult): void {
    if (result.success) return
    this.recordResult(accountId, result)
    this.pump()
  }

  private openCooldown(accountId: string, cooldownMs: number, reason: string, failures?: number): void {
    const now = Date.now()
    const current = this.accountCooldowns.get(accountId)
    this.accountCooldowns.set(accountId, {
      until: now + cooldownMs,
      failures: failures ?? current?.failures ?? 1,
      reason,
    })

    console.warn(
      `[QwenAI Governor] Account ${accountId} cooldown opened for ${Math.ceil(cooldownMs / 1000)}s (${reason})`,
    )
  }

  private recordGlobalRiskControl(accountId: string, config: QwenAiGovernorConfig): void {
    const now = Date.now()
    this.riskEvents = this.riskEvents
      .filter(event => now - event.timestamp <= config.riskWindowMs)
      .concat({ accountId, timestamp: now })

    const distinctRiskAccounts = new Set(this.riskEvents.map(event => event.accountId)).size
    if (distinctRiskAccounts < config.globalRiskThreshold) {
      return
    }

    const failures = (this.globalCooldown?.failures || 0) + 1
    const cooldownMs = Math.min(
      config.globalRiskCooldownMs * (2 ** (failures - 1)),
      config.maxGlobalRiskCooldownMs,
    )

    this.openGlobalCooldown(cooldownMs, 'qwen_ai_global_risk_circuit', failures)
  }

  private openGlobalCooldown(cooldownMs: number, reason: string, failures: number): void {
    const now = Date.now()
    this.globalCooldown = {
      until: now + cooldownMs,
      failures,
      reason,
    }

    console.warn(
      `[QwenAI Governor] Global circuit opened for ${Math.ceil(cooldownMs / 1000)}s (${reason})`,
    )

    this.rejectQueuedRequestsForGlobalCircuit(cooldownMs)
  }

  private expireCooldown(accountId: string, now: number): void {
    const cooldown = this.accountCooldowns.get(accountId)
    if (cooldown && cooldown.until <= now) {
      this.accountCooldowns.delete(accountId)
    }
  }

  private expireGlobalCooldown(now: number): void {
    if (this.globalCooldown && this.globalCooldown.until <= now) {
      this.globalCooldown = undefined
      this.riskEvents = this.riskEvents.filter(event => now - event.timestamp <= this.getConfig().riskWindowMs)
    }
  }

  private getGlobalCooldownInMs(now: number): number {
    return Math.max(0, (this.globalCooldown?.until || 0) - now)
  }

  private createGlobalCircuitOpenResult(waitMs: number): ForwardResult {
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000))
    return {
      success: false,
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
      error: `Qwen AI global risk circuit is open; retry after ${retryAfterSeconds}s`,
    }
  }

  private rejectQueuedRequestsForGlobalCircuit(waitMs: number): void {
    if (this.queue.length === 0) return

    const queued = this.queue.splice(0)
    const result = this.createGlobalCircuitOpenResult(waitMs)
    for (const item of queued) {
      item.cancelled = true
      this.clearQueueItemWaiters(item)
      item.resolve(item.signal?.aborted
        ? this.createCancelledResult('Client disconnected while Qwen AI request was queued.')
        : { ...result })
    }
  }

  private getConfig(): QwenAiGovernorConfig {
    try {
      const config = storeManager.getConfig().qwenAiGovernorConfig || {}
      const persistedConfig = normalizeQwenAiGovernorConfig({
        ...ENV_DEFAULT_CONFIG,
        ...config,
        autoTuneEnabled: config.autoTuneEnabled ?? ENV_DEFAULT_CONFIG.autoTuneEnabled,
        autoTuneMaxConcurrent: config.autoTuneMaxConcurrent ?? ENV_DEFAULT_CONFIG.autoTuneMaxConcurrent,
        autoTuneMinGlobalIntervalMs: Math.max(
          0,
          config.autoTuneMinGlobalIntervalMs ?? ENV_DEFAULT_CONFIG.autoTuneMinGlobalIntervalMs,
        ),
        maxConcurrent: config.maxConcurrent ?? ENV_DEFAULT_CONFIG.maxConcurrent,
        globalRiskThreshold: config.globalRiskThreshold ?? ENV_DEFAULT_CONFIG.globalRiskThreshold,
      })
      return applyExplicitEnvironmentOverrides(persistedConfig)
    } catch {
      return applyExplicitEnvironmentOverrides(ENV_DEFAULT_CONFIG)
    }
  }

  private getRecentRiskEventCount(config: QwenAiGovernorConfig, now: number): number {
    return this.riskEvents
      .filter(event => now - event.timestamp <= config.riskWindowMs)
      .length
  }

  private getRecentRiskAccountCount(config: QwenAiGovernorConfig, now: number): number {
    return new Set(
      this.riskEvents
        .filter(event => now - event.timestamp <= config.riskWindowMs)
        .map(event => event.accountId),
    ).size
  }

  private getQwenAiAccountScope(loadBalancerFailures: Record<string, {
    count: number
    lastFailTime: number
    cooldownUntil?: number
    reason?: string
  }> = {}): {
    accountCount: number
    healthyAccountCount: number
    coolingAccountCount: number
  } {
    const now = Date.now()
    const providers = storeManager.getProviders()
    const qwenAiProviderIds = providers
      .filter(provider => provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai'))
      .map(provider => provider.id)

    const accounts = storeManager.getAccounts()
      .filter(account => qwenAiProviderIds.includes(account.providerId))
      .filter(account => isConfiguredActiveStatus(account.status))

    let healthyAccountCount = 0
    let coolingAccountCount = 0

    for (const account of accounts) {
      this.expireCooldown(account.id, now)
      const governorCooldownInMs = Math.max(0, (this.accountCooldowns.get(account.id)?.until || 0) - now)
      const loadBalancerCooldownInMs = Math.max(0, (loadBalancerFailures[account.id]?.cooldownUntil || 0) - now)

      if (governorCooldownInMs > 0 || loadBalancerCooldownInMs > 0) {
        coolingAccountCount += 1
      } else {
        healthyAccountCount += 1
      }
    }

    return {
      accountCount: accounts.length,
      healthyAccountCount,
      coolingAccountCount,
    }
  }

  private calculateEffectiveConfig(
    config: QwenAiGovernorConfig,
    options: {
      healthyAccountCount: number
      coolingAccountCount: number
      recentRiskEvents: number
    },
  ): QwenAiGovernorEffectiveConfig {
    const configuredMaxConcurrent = Math.max(1, config.maxConcurrent)
    const configuredGlobalMinIntervalMs = Math.max(0, config.globalMinIntervalMs)
    const adaptiveLimits = calculateQwenAiAdaptiveLimits({
      autoTuneEnabled: config.autoTuneEnabled,
      autoTuneMaxConcurrent: config.autoTuneMaxConcurrent,
      autoTuneMinGlobalIntervalMs: config.autoTuneMinGlobalIntervalMs,
      configuredMaxConcurrent,
      configuredGlobalMinIntervalMs,
      accountMinIntervalMs: config.accountMinIntervalMs,
      healthyAccountCount: options.healthyAccountCount,
      recentRiskEvents: options.recentRiskEvents,
    })

    return {
      ...config,
      maxConcurrent: adaptiveLimits.maxConcurrent,
      globalMinIntervalMs: adaptiveLimits.globalMinIntervalMs,
      configuredMaxConcurrent,
      configuredGlobalMinIntervalMs,
      healthyAccountCount: options.healthyAccountCount,
      coolingAccountCount: options.coolingAccountCount,
      autoTuneReason: adaptiveLimits.autoTuneReason,
    }
  }

  private getEffectiveConfig(loadBalancerFailures?: Record<string, {
    count: number
    lastFailTime: number
    cooldownUntil?: number
    reason?: string
  }>): QwenAiGovernorEffectiveConfig {
    const config = this.getConfig()
    const now = Date.now()
    const accountScope = this.getQwenAiAccountScope(loadBalancerFailures)

    return this.calculateEffectiveConfig(config, {
      healthyAccountCount: accountScope.healthyAccountCount,
      coolingAccountCount: accountScope.coolingAccountCount,
      recentRiskEvents: this.getRecentRiskEventCount(config, now),
    })
  }

  getConfiguredConfig(): QwenAiGovernorConfig {
    return { ...this.getConfig() }
  }

  isAccountImmediatelyAvailable(accountId: string, now = Date.now()): boolean {
    this.expireCooldown(accountId, now)
    return (
      this.getGlobalCooldownInMs(now) === 0
      && (this.activeByAccount.get(accountId) || 0) === 0
      && (this.accountNextAvailableAt.get(accountId) || 0) <= now
      && (this.accountCooldowns.get(accountId)?.until || 0) <= now
    )
  }

  getStatus(
    accounts: Account[],
    providers: Provider[],
    loadBalancerFailures: Record<string, {
      count: number
      lastFailTime: number
      cooldownUntil?: number
      reason?: string
    }> = {},
  ): QwenAiGovernorStatus {
    const now = Date.now()
    const config = this.getConfig()
    const effectiveConfig = this.getEffectiveConfig(loadBalancerFailures)
    this.expireGlobalCooldown(now)
    const globalCooldownUntil = this.globalCooldown?.until || 0
    const globalNextAvailableAt = Math.max(
      this.lastGlobalStartAt + effectiveConfig.globalMinIntervalMs,
      globalCooldownUntil,
    )
    const providerById = new Map(providers.map(provider => [provider.id, provider]))
    const recentRiskEvents = this.getRecentRiskEventCount(config, now)
    const recentRiskAccounts = this.getRecentRiskAccountCount(config, now)

    const accountStatuses = accounts.map(account => {
      this.expireCooldown(account.id, now)
      const governorCooldown = this.accountCooldowns.get(account.id)
      const loadBalancerFailure = loadBalancerFailures[account.id]
      const accountNextAvailableAt = this.accountNextAvailableAt.get(account.id) || 0
      const readyAt = Math.max(
        globalNextAvailableAt,
        accountNextAvailableAt,
        governorCooldown?.until || 0,
        loadBalancerFailure?.cooldownUntil || 0,
      )
      const provider = providerById.get(account.providerId)

      return {
        accountId: account.id,
        accountName: account.name,
        providerId: account.providerId,
        providerName: provider?.name || account.providerId,
        status: account.status,
        queuedRequests: this.queue.filter(item => item.accountId === account.id).length,
        activeRequests: this.activeByAccount.get(account.id) || 0,
        nextAvailableAt: readyAt > now ? readyAt : undefined,
        nextAvailableInMs: Math.max(0, readyAt - now),
        governorCooldownUntil: governorCooldown && governorCooldown.until > now ? governorCooldown.until : undefined,
        governorCooldownInMs: Math.max(0, (governorCooldown?.until || 0) - now),
        governorCooldownReason: governorCooldown?.reason,
        governorFailures: governorCooldown?.failures || 0,
        loadBalancerCooldownUntil:
          loadBalancerFailure?.cooldownUntil && loadBalancerFailure.cooldownUntil > now
            ? loadBalancerFailure.cooldownUntil
            : undefined,
        loadBalancerCooldownInMs: Math.max(0, (loadBalancerFailure?.cooldownUntil || 0) - now),
        loadBalancerReason: loadBalancerFailure?.reason,
        loadBalancerFailures: loadBalancerFailure?.count || 0,
      }
    })

    return {
      config,
      effectiveConfig,
      queueSize: this.queue.length,
      activeRequests: this.active,
      globalNextAvailableAt: globalNextAvailableAt > now ? globalNextAvailableAt : undefined,
      globalNextAvailableInMs: Math.max(0, globalNextAvailableAt - now),
      globalCooldownUntil:
        this.globalCooldown?.until && this.globalCooldown.until > now ? this.globalCooldown.until : undefined,
      globalCooldownInMs: this.getGlobalCooldownInMs(now),
      globalCooldownReason: this.globalCooldown?.reason,
      globalFailures: this.globalCooldown?.failures || 0,
      recentRiskEvents,
      recentRiskAccounts,
      accounts: accountStatuses,
    }
  }

  clearAccountCooldown(accountId: string): void {
    this.accountCooldowns.delete(accountId)
    this.accountNextAvailableAt.delete(accountId)
    this.pump()
  }

  clearAllCooldowns(): void {
    this.accountCooldowns.clear()
    this.accountNextAvailableAt.clear()
    this.globalCooldown = undefined
    this.riskEvents = []
    this.pump()
  }
}

export const qwenAiRequestGovernor = new QwenAiRequestGovernor()
