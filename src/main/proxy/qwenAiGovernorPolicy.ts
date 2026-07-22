export type QwenAiRequestReadyAtInput = {
  lastGlobalStartAt: number
  globalMinIntervalMs: number
  accountNextAvailableAt: number
  accountCooldownUntil: number
  recoveryBypassAccountInterval: boolean
  accountActive?: boolean
}

export type QwenAiAdaptiveLimitsInput = {
  autoTuneEnabled: boolean
  autoTuneMaxConcurrent: number
  autoTuneMinGlobalIntervalMs: number
  configuredMaxConcurrent: number
  configuredGlobalMinIntervalMs: number
  accountMinIntervalMs: number
  healthyAccountCount: number
  recentRiskEvents: number
}

export type QwenAiAdaptiveLimits = {
  maxConcurrent: number
  globalMinIntervalMs: number
  autoTuneReason: string
}

const RISK_CONCURRENCY = 1
const RISK_GLOBAL_INTERVAL_MS = 15_000

/**
 * Scale aggregate throughput with the healthy account pool. The configured
 * auto-tune cap remains the safety ceiling, while per-account in-flight
 * admission prevents two requests from sharing one account concurrently.
 */
export function calculateQwenAiAdaptiveLimits(input: QwenAiAdaptiveLimitsInput): QwenAiAdaptiveLimits {
  const configuredMaxConcurrent = Math.max(1, Math.floor(input.configuredMaxConcurrent))
  const configuredGlobalMinIntervalMs = Math.max(0, Math.floor(input.configuredGlobalMinIntervalMs))

  if (!input.autoTuneEnabled) {
    return {
      maxConcurrent: configuredMaxConcurrent,
      globalMinIntervalMs: configuredGlobalMinIntervalMs,
      autoTuneReason: 'manual',
    }
  }

  if (input.recentRiskEvents > 0) {
    return {
      maxConcurrent: RISK_CONCURRENCY,
      globalMinIntervalMs: Math.max(configuredGlobalMinIntervalMs, RISK_GLOBAL_INTERVAL_MS),
      autoTuneReason: 'recent_risk_events',
    }
  }

  const healthyAccountCount = Math.max(0, Math.floor(input.healthyAccountCount))
  if (healthyAccountCount <= 1) {
    return {
      maxConcurrent: RISK_CONCURRENCY,
      globalMinIntervalMs: Math.max(configuredGlobalMinIntervalMs, RISK_GLOBAL_INTERVAL_MS),
      autoTuneReason: 'single_or_no_healthy_account',
    }
  }

  const accountBasedConcurrency = healthyAccountCount
  const accountBasedIntervalMs = Math.ceil(
    Math.max(0, input.accountMinIntervalMs) / healthyAccountCount,
  )

  return {
    maxConcurrent: Math.max(
      1,
      Math.min(accountBasedConcurrency, Math.max(1, Math.floor(input.autoTuneMaxConcurrent))),
    ),
    globalMinIntervalMs: Math.max(
      Math.max(0, Math.floor(input.autoTuneMinGlobalIntervalMs)),
      accountBasedIntervalMs,
    ),
    autoTuneReason: `healthy_accounts_${healthyAccountCount}`,
  }
}

/**
 * Parse an upstream Retry-After header. HTTP allows either a delay in seconds
 * or an absolute HTTP date; malformed values are ignored by the governor.
 */
export function parseQwenAiRetryAfterMs(
  headers: Record<string, string> | undefined,
  now = Date.now(),
): number | undefined {
  if (!headers) return undefined

  const value = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
    ?.trim()
  if (!value) return undefined

  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.ceil(seconds * 1000)
      : undefined
  }

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, timestamp - now)
}

/**
 * A recovery attempt may skip only the ordinary per-account spacing. Global
 * pacing and risk/failure cooldowns remain authoritative.
 */
export function calculateQwenAiRequestReadyAt(input: QwenAiRequestReadyAtInput): number {
  if (input.accountActive) {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(
    input.lastGlobalStartAt + input.globalMinIntervalMs,
    input.recoveryBypassAccountInterval ? 0 : input.accountNextAvailableAt,
    input.accountCooldownUntil,
  )
}
