import type { Account, Provider } from '../store/types'
import { storeManager } from '../store/store'
import {
  hasQwenAiSessionCookie,
  qwenAiRefreshRiskGateRemainingMs,
  qwenAiTokenRefresher,
} from './adapters/qwen-ai-token-refresh'

const DEFAULT_REPAIR_INTERVAL_MS = 25_000
const DEFAULT_RESCAN_INTERVAL_MS = 60_000
const DEFAULT_FAILURE_RETRY_MS = 5 * 60_000
const DEFAULT_CREDENTIAL_RETRY_MS = 6 * 60 * 60_000
const DEFAULT_RISK_COOLDOWN_MS = 180_000
const DEFAULT_PROBE_INTERVAL_MS = 6 * 60 * 60_000

export type QwenAiSessionRepairState =
  | 'ready'
  | 'pending'
  | 'repairing'
  | 'backoff'
  | 'probe'
  | 'unrepairable'

export interface QwenAiSessionRepairAccountStatus {
  state: QwenAiSessionRepairState
  ready: boolean
  repairable: boolean
  nextAttemptAt?: number
}

export type QwenAiSessionRepairResult =
  | { status: 'repaired'; accountId: string }
  | { status: 'failed'; accountId: string; nextAttemptAt: number; globalPauseUntil?: number }
  | { status: 'paused'; nextAttemptAt: number }
  | { status: 'idle'; nextAttemptAt?: number }

type RepairError = Error & {
  status?: number
  code?: string
  accountFault?: boolean
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (['0', 'false', 'off', 'no'].includes(value)) return false
  if (['1', 'true', 'on', 'yes'].includes(value)) return true
  return fallback
}

function envDuration(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback
}

function isQwenAiProvider(provider: Provider): boolean {
  return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
}

export function isQwenAiWebSessionReady(account: Account): boolean {
  const cookies = String(account.credentials.cookies || account.credentials.cookie || '')
  return hasQwenAiSessionCookie(cookies)
}

export function isQwenAiWebSessionRepairable(account: Account): boolean {
  return Boolean(account.credentials.email && account.credentials.password)
}

function probeIntervalMs(): number {
  return envDuration(
    'CHAT2API_QWEN_AI_SESSION_REPAIR_PROBE_INTERVAL_MS',
    DEFAULT_PROBE_INTERVAL_MS,
    60_000,
  )
}

/**
 * When a non-active account becomes eligible for a re-probe.
 *
 * Derived from the account's own `updatedAt` (the moment it was frozen) so the
 * schedule survives a process restart instead of restarting from zero. It is
 * deterministic on purpose: this method is called from the management view.
 */
export function qwenAiSessionRepairProbeDeadline(account: Account, now: number = Date.now()): number {
  const frozenAt = Number(account.updatedAt)
  if (!Number.isFinite(frozenAt) || frozenAt <= 0 || frozenAt > now) {
    return 0
  }
  return frozenAt + probeIntervalMs()
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown session repair failure'
  return message
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/((?:token|cookie|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 300)
}

export class QwenAiSessionRepairService {
  private running = false
  private timer?: NodeJS.Timeout
  private abortController?: AbortController
  private inFlight?: Promise<QwenAiSessionRepairResult>
  private inFlightAccountId?: string
  private nextRunAt?: number
  private globalPauseUntil = 0
  private retryAfterByAccount = new Map<string, number>()

  isEnabled(): boolean {
    return envBoolean('CHAT2API_QWEN_AI_SESSION_REPAIR_ENABLED', true)
  }

  start(): void {
    if (this.running || !this.isEnabled()) return
    this.running = true

    const summary = this.getPoolSummary()
    console.info(
      `[QwenAI Session Repair] started ready=${summary.ready} pending=${summary.pending} `
      + `probe=${summary.probe} unrepairable=${summary.unrepairable}`,
    )
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined
    this.abortController?.abort()
    this.abortController = undefined
  }

  wake(): void {
    if (!this.running || this.inFlight) return
    this.schedule(0)
  }

  getAccountStatus(account: Account, now = Date.now()): QwenAiSessionRepairAccountStatus {
    if (this.inFlightAccountId === account.id) {
      return { state: 'repairing', ready: false, repairable: true }
    }

    if (account.status !== 'active') {
      // A frozen account still holds its login credentials, so the pool must
      // stay recoverable. Excluding it from this queue forever made the
      // refresher unable to undo its own "not registered" verdict: on
      // 2026-09-22 all 340 accounts were frozen within 2.4h and Qwen stayed
      // dark even though every signin succeeded when retried by hand. Probe a
      // repairable account on a long interval instead of parking it.
      if (!isQwenAiWebSessionRepairable(account)) {
        return { state: 'unrepairable', ready: false, repairable: false }
      }

      const nextAttemptAt = Math.max(
        qwenAiSessionRepairProbeDeadline(account, now),
        this.retryAfterByAccount.get(account.id) || 0,
        this.globalPauseUntil,
      )

      return {
        state: 'probe',
        ready: false,
        repairable: true,
        ...(nextAttemptAt > now ? { nextAttemptAt } : {}),
      }
    }

    if (isQwenAiWebSessionReady(account)) {
      return { state: 'ready', ready: true, repairable: true }
    }

    const repairable = isQwenAiWebSessionRepairable(account)
    if (!repairable) {
      return { state: 'unrepairable', ready: false, repairable: false }
    }

    const nextAttemptAt = Math.max(
      this.retryAfterByAccount.get(account.id) || 0,
      this.globalPauseUntil,
    )
    if (nextAttemptAt > now) {
      return { state: 'backoff', ready: false, repairable: true, nextAttemptAt }
    }

    return { state: 'pending', ready: false, repairable: true }
  }

  getRuntimeStatus(): {
    running: boolean
    inFlightAccountId?: string
    nextRunAt?: number
    globalPauseUntil?: number
  } {
    return {
      running: this.running,
      inFlightAccountId: this.inFlightAccountId,
      nextRunAt: this.nextRunAt,
      globalPauseUntil: this.globalPauseUntil > Date.now() ? this.globalPauseUntil : undefined,
    }
  }

  async repairNext(signal?: AbortSignal): Promise<QwenAiSessionRepairResult> {
    if (this.inFlight) return this.inFlight

    const operation = this.performRepairNext(signal)
    this.inFlight = operation
    try {
      return await operation
    } finally {
      if (this.inFlight === operation) this.inFlight = undefined
    }
  }

  private async performRepairNext(signal?: AbortSignal): Promise<QwenAiSessionRepairResult> {
    const now = Date.now()
    if (this.globalPauseUntil > now) {
      return { status: 'paused', nextAttemptAt: this.globalPauseUntil }
    }

    // While the refresh endpoint is under WAF risk control, no credential is
    // being judged here - the endpoint is answering challenge pages. Picking an
    // account anyway records a failure against a healthy one and, because the
    // next scan is immediate, re-arms the gate before it can expire. That is
    // what turned one flagged egress into a livelock outliving the underlying
    // verdict by hours. Pause the whole loop instead.
    const refreshGateRemainingMs = qwenAiRefreshRiskGateRemainingMs()
    if (refreshGateRemainingMs > 0) {
      this.globalPauseUntil = now + refreshGateRemainingMs
      return { status: 'paused', nextAttemptAt: this.globalPauseUntil }
    }

    const accounts = this.getQwenAiAccounts()
    const candidate = this.selectCandidate(accounts, now)

    if (!candidate) {
      const nextAttemptAt = this.getEarliestRetryAt(now)
      return { status: 'idle', ...(nextAttemptAt ? { nextAttemptAt } : {}) }
    }

    this.inFlightAccountId = candidate.id
    const isProbe = candidate.status !== 'active'
    try {
      // A probe must prove the credentials still work before the account is
      // allowed back into the pool. `repairWebSession` is a no-op for an
      // account that still holds its session cookie, which is exactly the
      // state the 2026-09-22 freeze left behind: the probe would report
      // "repaired" forever while the account stayed inactive and unusable.
      const repaired = isProbe
        ? await qwenAiTokenRefresher.refreshAfterUnauthorized(candidate, signal)
        : await qwenAiTokenRefresher.repairWebSession(candidate, signal)
      if (!isQwenAiWebSessionReady(repaired)) {
        throw new Error('Qwen AI signin did not return the required session cookie')
      }
      if (repaired.status !== 'active') {
        throw new Error('Qwen AI signin did not reactivate the frozen account')
      }

      this.retryAfterByAccount.delete(candidate.id)
      console.info(
        `[QwenAI Session Repair] ${isProbe ? 're-probed' : 'repaired'} account=${candidate.id}`,
      )
      storeManager.addLog('info', `Qwen AI web session ${isProbe ? 're-probed' : 'repaired'}`, {
        accountId: candidate.id,
        providerId: candidate.providerId,
      })
      return { status: 'repaired', accountId: candidate.id }
    } catch (error) {
      const repairError = error as RepairError
      const status = Number(repairError.status)
      const riskControlled = status === 403 || status === 429
      const retryDelay = status === 401
        ? envDuration(
            'CHAT2API_QWEN_AI_SESSION_REPAIR_CREDENTIAL_RETRY_MS',
            DEFAULT_CREDENTIAL_RETRY_MS,
            60_000,
          )
        : envDuration(
            'CHAT2API_QWEN_AI_SESSION_REPAIR_FAILURE_RETRY_MS',
            DEFAULT_FAILURE_RETRY_MS,
            10_000,
          )
      const nextAttemptAt = Date.now() + retryDelay
      // A locally generated gate rejection carries no evidence about this
      // account: the request never left the process. Recording it would push a
      // healthy account into backoff for a verdict the upstream never made, so
      // only the global pause is updated.
      const gatedByEgress = repairError.code === 'qwen_ai_token_refresh_gated'
      if (!gatedByEgress) {
        this.retryAfterByAccount.set(candidate.id, nextAttemptAt)
      }

      if (riskControlled) {
        const riskCooldownMs = envDuration(
          'CHAT2API_QWEN_AI_SESSION_REPAIR_RISK_COOLDOWN_MS',
          DEFAULT_RISK_COOLDOWN_MS,
          60_000,
        )
        this.globalPauseUntil = Date.now() + riskCooldownMs
      }

      if (gatedByEgress) {
        // One line per pause, not one per account: a long gate would otherwise
        // bury the pool log and hide the real state.
        console.info(
          `[QwenAI Session Repair] refresh gate active; deferring repairs for `
          + `${Math.max(0, Math.ceil((this.globalPauseUntil - Date.now()) / 1000))}s`,
        )
        return {
          status: 'paused',
          nextAttemptAt: Math.max(this.globalPauseUntil, nextAttemptAt),
        }
      }

      const message = safeErrorMessage(error)
      console.warn(
        `[QwenAI Session Repair] failed account=${candidate.id} status=${Number.isFinite(status) ? status : '-'} code=${repairError.code || '-'} message=${message}`,
      )
      storeManager.addLog('warn', `Qwen AI web session repair failed: ${message}`, {
        accountId: candidate.id,
        providerId: candidate.providerId,
        errorCode: repairError.code,
      })

      return {
        status: 'failed',
        accountId: candidate.id,
        nextAttemptAt,
        ...(this.globalPauseUntil > Date.now()
          ? { globalPauseUntil: this.globalPauseUntil }
          : {}),
      }
    } finally {
      this.inFlightAccountId = undefined
    }
  }

  /**
   * Active accounts are served first; a due probe of a frozen account is the
   * fallback, so re-probing never delays the accounts that are live today.
   */
  private selectCandidate(accounts: Account[], now: number): Account | undefined {
    const isDueActive = (account: Account) => account.status === 'active'
      && this.getAccountStatus(account, now).state === 'pending'
    const isDueProbe = (account: Account) => account.status !== 'active'
      && this.getAccountStatus(account, now).state === 'probe'
      && !this.getAccountStatus(account, now).nextAttemptAt

    return accounts.find(isDueActive) || accounts.find(isDueProbe)
  }

  private getQwenAiAccounts(): Account[] {
    const providers = storeManager.getProviders()
    const providerIds = new Set(
      providers.filter(isQwenAiProvider).map(provider => provider.id),
    )
    return storeManager.getAccounts(true)
      .filter(account => providerIds.has(account.providerId))
  }

  private getPoolSummary(): { ready: number; pending: number; probe: number; unrepairable: number } {
    return this.getQwenAiAccounts().reduce((summary, account) => {
      const status = this.getAccountStatus(account)
      if (status.ready) return { ...summary, ready: summary.ready + 1 }
      if (!status.repairable) return { ...summary, unrepairable: summary.unrepairable + 1 }
      if (status.state === 'probe') return { ...summary, probe: summary.probe + 1 }
      return { ...summary, pending: summary.pending + 1 }
    }, { ready: 0, pending: 0, probe: 0, unrepairable: 0 })
  }

  private getEarliestRetryAt(now: number): number | undefined {
    const nextProbeAt = this.getQwenAiAccounts().reduce((earliest, account) => {
      if (account.status === 'active') return earliest
      const deadline = qwenAiSessionRepairProbeDeadline(account, now)
      if (deadline <= now) return earliest
      return earliest === 0 ? deadline : Math.min(earliest, deadline)
    }, 0)

    const candidates = [
      this.globalPauseUntil,
      nextProbeAt,
      ...this.retryAfterByAccount.values(),
    ].filter(timestamp => timestamp > now)
    return candidates.length > 0 ? Math.min(...candidates) : undefined
  }

  private schedule(delayMs: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)

    const delay = Math.max(0, delayMs)
    this.nextRunAt = Date.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextRunAt = undefined
      void this.runScheduled()
    }, delay)
    this.timer.unref?.()
  }

  private async runScheduled(): Promise<void> {
    if (!this.running) return

    this.abortController = new AbortController()
    let result: QwenAiSessionRepairResult
    try {
      result = await this.repairNext(this.abortController.signal)
    } finally {
      this.abortController = undefined
    }

    if (!this.running) return

    const now = Date.now()
    const repairIntervalMs = envDuration(
      'CHAT2API_QWEN_AI_SESSION_REPAIR_INTERVAL_MS',
      DEFAULT_REPAIR_INTERVAL_MS,
      1_000,
    )
    const rescanIntervalMs = envDuration(
      'CHAT2API_QWEN_AI_SESSION_REPAIR_RESCAN_MS',
      DEFAULT_RESCAN_INTERVAL_MS,
      5_000,
    )

    if (result.status === 'paused') {
      this.schedule(Math.max(repairIntervalMs, result.nextAttemptAt - now))
      return
    }

    if (result.status === 'idle') {
      const retryDelay = result.nextAttemptAt
        ? Math.max(repairIntervalMs, result.nextAttemptAt - now)
        : rescanIntervalMs
      this.schedule(Math.min(rescanIntervalMs, retryDelay))
      return
    }

    if (result.status === 'failed' && result.globalPauseUntil) {
      this.schedule(Math.max(repairIntervalMs, result.globalPauseUntil - now))
      return
    }

    this.schedule(repairIntervalMs)
  }
}

export const qwenAiSessionRepairService = new QwenAiSessionRepairService()
