import type { ForwardResult } from './types'
import { storeManager } from '../store/store'
import type {
  Account,
  AccountStatus,
  Provider,
  QwenAiGovernorConfig,
} from '../store/types'
import type { QwenAiGovernorEffectiveConfig, QwenAiGovernorStatus } from '../../shared/types'

type QueueItem = {
  id: string
  accountId: string
  run: () => Promise<ForwardResult>
  resolve: (value: ForwardResult) => void
  reject: (reason: unknown) => void
  enqueuedAt: number
  timeout?: NodeJS.Timeout
  signal?: AbortSignal
  cancelled: boolean
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

const ENV_DEFAULT_CONFIG: QwenAiGovernorConfig = {
  autoTuneEnabled: process.env.CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED !== 'false',
  autoTuneMaxConcurrent: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT', 2)),
  autoTuneMinGlobalIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS', 8000),
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
  numberFromEnv('CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS', 2 * 60 * 1000),
)

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function isQwenRiskControl(error?: string, status?: number): boolean {
  return Boolean(
    status === 403 &&
    error &&
    /qwen_ai_risk_control|FAIL_SYS_USER_VALIDATE|RGV587|bxpunish|risk-control|challenge|x5sec|baxia|punish/i.test(error),
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

  run(accountId: string, run: () => Promise<ForwardResult>, options: { signal?: AbortSignal } = {}): Promise<ForwardResult> {
    return new Promise((resolve, reject) => {
      const now = Date.now()
      this.expireGlobalCooldown(now)
      const globalCooldownInMs = this.getGlobalCooldownInMs(now)
      if (globalCooldownInMs > 0) {
        resolve(this.createGlobalCircuitOpenResult(globalCooldownInMs))
        return
      }

      if (options.signal?.aborted) {
        resolve(this.createCancelledResult('Client disconnected before Qwen AI request was queued.'))
        return
      }

      const item: QueueItem = {
        id: String(this.nextQueueItemId++),
        accountId,
        run,
        resolve,
        reject,
        enqueuedAt: now,
        signal: options.signal,
        cancelled: false,
      }

      const cancelQueued = (message: string) => {
        if (item.cancelled) return
        item.cancelled = true
        this.removeQueuedItem(item)
        resolve(this.createCancelledResult(message))
      }

      item.timeout = setTimeout(() => {
        cancelQueued(`Qwen AI request waited in queue for more than ${Math.ceil(QWEN_AI_QUEUE_TIMEOUT_MS / 1000)}s.`)
      }, QWEN_AI_QUEUE_TIMEOUT_MS)

      options.signal?.addEventListener('abort', () => {
        cancelQueued('Client disconnected while Qwen AI request was queued.')
      }, { once: true })

      this.queue.push(item)
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

  private clearQueueItemTimeout(item: QueueItem): void {
    if (item.timeout) {
      clearTimeout(item.timeout)
      item.timeout = undefined
    }
  }

  private removeQueuedItem(item: QueueItem): void {
    const index = this.queue.findIndex(candidate => candidate === item || candidate.id === item.id)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.pump()
    }
    this.clearQueueItemTimeout(item)
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
        const readyAt = this.getReadyAt(this.queue[index].accountId, now)
        if (readyAt <= now) {
          selectedIndex = index
          break
        }
        nextReadyAt = Math.min(nextReadyAt, readyAt)
      }

      if (selectedIndex === -1) {
        const delayMs = Math.max(50, nextReadyAt - now)
        this.timer = setTimeout(() => this.pump(), delayMs)
        return
      }

      const item = this.queue.splice(selectedIndex, 1)[0]
      this.clearQueueItemTimeout(item)
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
    this.active += 1
    this.activeByAccount.set(item.accountId, (this.activeByAccount.get(item.accountId) || 0) + 1)
    this.lastGlobalStartAt = startedAt
    this.accountNextAvailableAt.set(item.accountId, startedAt + config.accountMinIntervalMs)

    let released = false
    let settledByAbort = false
    const release = () => {
      if (!released) {
        released = true
        this.active -= 1
        this.activeByAccount.set(item.accountId, Math.max(0, (this.activeByAccount.get(item.accountId) || 1) - 1))
        this.pump()
      }
    }

    const abortActive = () => {
      if (settledByAbort) return
      settledByAbort = true
      release()
      item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
    }

    item.signal?.addEventListener('abort', abortActive, { once: true })

    item.run()
      .then((result) => {
        if (item.cancelled || item.signal?.aborted) {
          item.signal?.removeEventListener('abort', abortActive)
          destroyForwardStream(result.stream)
          release()
          item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
          return
        }

        this.recordResult(item.accountId, result)
        if (result.success && result.stream) {
          const releaseStream = () => {
            item.signal?.removeEventListener('abort', abortActive)
            release()
          }
          attachRelease(result.stream, releaseStream)
          if (item.signal?.aborted) {
            releaseStream()
          }
        } else {
          item.signal?.removeEventListener('abort', abortActive)
          release()
        }
        item.resolve(result)
      })
      .catch((error) => {
        item.signal?.removeEventListener('abort', abortActive)
        this.openCooldown(item.accountId, this.getConfig().failureCooldownMs, 'exception')
        release()
        item.reject(error)
      })
  }

  private getReadyAt(accountId: string, now: number): number {
    const config = this.getEffectiveConfig()
    this.expireCooldown(accountId, now)

    return Math.max(
      this.lastGlobalStartAt + config.globalMinIntervalMs,
      this.accountNextAvailableAt.get(accountId) || 0,
      this.accountCooldowns.get(accountId)?.until || 0,
    )
  }

  private recordResult(accountId: string, result: ForwardResult): void {
    if (result.success) {
      this.accountCooldowns.delete(accountId)
      return
    }

    if (isQwenRiskControl(result.error, result.status)) {
      const config = this.getConfig()
      const current = this.accountCooldowns.get(accountId)
      const failures = (current?.failures || 0) + 1
      const cooldownMs = Math.min(config.riskCooldownMs * (2 ** (failures - 1)), config.maxRiskCooldownMs)
      this.openCooldown(accountId, cooldownMs, 'qwen_ai_risk_control', failures)
      this.recordGlobalRiskControl(accountId, config)
      return
    }

    if (result.status === 429 || (result.status !== undefined && result.status >= 500)) {
      this.openCooldown(accountId, this.getConfig().failureCooldownMs, `http_${result.status}`)
    }
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
      item.resolve({ ...result })
    }
  }

  private getConfig(): QwenAiGovernorConfig {
    try {
      const config = storeManager.getConfig().qwenAiGovernorConfig
      return {
        ...ENV_DEFAULT_CONFIG,
        ...config,
        autoTuneEnabled: config.autoTuneEnabled ?? ENV_DEFAULT_CONFIG.autoTuneEnabled,
        autoTuneMaxConcurrent: Math.max(1, config.autoTuneMaxConcurrent || ENV_DEFAULT_CONFIG.autoTuneMaxConcurrent),
        autoTuneMinGlobalIntervalMs: Math.max(
          0,
          config.autoTuneMinGlobalIntervalMs ?? ENV_DEFAULT_CONFIG.autoTuneMinGlobalIntervalMs,
        ),
        maxConcurrent: Math.max(1, config.maxConcurrent || ENV_DEFAULT_CONFIG.maxConcurrent),
        globalRiskThreshold: Math.max(1, config.globalRiskThreshold || ENV_DEFAULT_CONFIG.globalRiskThreshold),
      }
    } catch {
      return ENV_DEFAULT_CONFIG
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
    let maxConcurrent = configuredMaxConcurrent
    let globalMinIntervalMs = configuredGlobalMinIntervalMs
    let autoTuneReason = 'manual'

    if (config.autoTuneEnabled) {
      if (options.recentRiskEvents > 0) {
        maxConcurrent = 1
        globalMinIntervalMs = Math.max(configuredGlobalMinIntervalMs, 15000)
        autoTuneReason = 'recent_risk_events'
      } else if (options.healthyAccountCount <= 1) {
        maxConcurrent = 1
        globalMinIntervalMs = Math.max(configuredGlobalMinIntervalMs, 15000)
        autoTuneReason = 'single_or_no_healthy_account'
      } else {
        const accountBasedConcurrency = options.healthyAccountCount >= 8
          ? 3
          : options.healthyAccountCount >= 4
            ? 2
            : 1
        const accountBasedInterval = options.healthyAccountCount >= 8
          ? 8000
          : options.healthyAccountCount >= 4
            ? 10000
            : 12000

        maxConcurrent = Math.max(
          1,
          Math.min(accountBasedConcurrency, config.autoTuneMaxConcurrent),
        )
        globalMinIntervalMs = Math.max(
          config.autoTuneMinGlobalIntervalMs,
          Math.min(configuredGlobalMinIntervalMs, accountBasedInterval),
        )
        autoTuneReason = `healthy_accounts_${options.healthyAccountCount}`
      }
    }

    return {
      ...config,
      maxConcurrent,
      globalMinIntervalMs,
      configuredMaxConcurrent,
      configuredGlobalMinIntervalMs,
      healthyAccountCount: options.healthyAccountCount,
      coolingAccountCount: options.coolingAccountCount,
      autoTuneReason,
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
