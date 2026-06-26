import type { ForwardResult } from './types'
import { storeManager } from '../store/store'
import type {
  Account,
  Provider,
  QwenAiGovernorConfig,
} from '../store/types'
import type { QwenAiGovernorStatus } from '../../shared/types'

type QueueItem = {
  accountId: string
  run: () => Promise<ForwardResult>
  resolve: (value: ForwardResult) => void
  reject: (reason: unknown) => void
}

type CooldownState = {
  until: number
  failures: number
  reason: string
}

const ENV_DEFAULT_CONFIG: QwenAiGovernorConfig = {
  maxConcurrent: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_MAX_CONCURRENT', 1)),
  globalMinIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS', 4000),
  accountMinIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS', 45000),
  riskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_RISK_COOLDOWN_MS', 10 * 60 * 1000),
  maxRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_MAX_RISK_COOLDOWN_MS', 30 * 60 * 1000),
  failureCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_FAILURE_COOLDOWN_MS', 2 * 60 * 1000),
}

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

export class QwenAiRequestGovernor {
  private queue: QueueItem[] = []
  private active = 0
  private lastGlobalStartAt = 0
  private timer: NodeJS.Timeout | undefined
  private accountNextAvailableAt: Map<string, number> = new Map()
  private accountCooldowns: Map<string, CooldownState> = new Map()
  private activeByAccount: Map<string, number> = new Map()

  run(accountId: string, run: () => Promise<ForwardResult>): Promise<ForwardResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ accountId, run, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    const config = this.getConfig()

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
      this.start(item)
    }
  }

  private start(item: QueueItem): void {
    const config = this.getConfig()
    const startedAt = Date.now()
    this.active += 1
    this.activeByAccount.set(item.accountId, (this.activeByAccount.get(item.accountId) || 0) + 1)
    this.lastGlobalStartAt = startedAt
    this.accountNextAvailableAt.set(item.accountId, startedAt + config.accountMinIntervalMs)

    let released = false
    const release = () => {
      if (!released) {
        released = true
        this.active -= 1
        this.activeByAccount.set(item.accountId, Math.max(0, (this.activeByAccount.get(item.accountId) || 1) - 1))
        this.pump()
      }
    }

    item.run()
      .then((result) => {
        this.recordResult(item.accountId, result)
        if (result.success && result.stream) {
          attachRelease(result.stream, release)
        } else {
          release()
        }
        item.resolve(result)
      })
      .catch((error) => {
        this.openCooldown(item.accountId, this.failureCooldownMs, 'exception')
        release()
        item.reject(error)
      })
  }

  private getReadyAt(accountId: string, now: number): number {
    const config = this.getConfig()
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

  private expireCooldown(accountId: string, now: number): void {
    const cooldown = this.accountCooldowns.get(accountId)
    if (cooldown && cooldown.until <= now) {
      this.accountCooldowns.delete(accountId)
    }
  }

  private getConfig(): QwenAiGovernorConfig {
    try {
      const config = storeManager.getConfig().qwenAiGovernorConfig
      return {
        ...ENV_DEFAULT_CONFIG,
        ...config,
        maxConcurrent: Math.max(1, config.maxConcurrent || ENV_DEFAULT_CONFIG.maxConcurrent),
      }
    } catch {
      return ENV_DEFAULT_CONFIG
    }
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
    const globalNextAvailableAt = this.lastGlobalStartAt + config.globalMinIntervalMs
    const providerById = new Map(providers.map(provider => [provider.id, provider]))

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
      queueSize: this.queue.length,
      activeRequests: this.active,
      globalNextAvailableAt: globalNextAvailableAt > now ? globalNextAvailableAt : undefined,
      globalNextAvailableInMs: Math.max(0, globalNextAvailableAt - now),
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
    this.pump()
  }
}

export const qwenAiRequestGovernor = new QwenAiRequestGovernor()
