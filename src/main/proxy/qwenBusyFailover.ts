import type { ForwardResult } from './types'

/**
 * Stop rule for the qwen upstream-busy pattern: when EVERY failure in this
 * request has been the same busy/risk page, the payload is being rejected,
 * not throttled for capacity. Rotating more accounts only keeps hammering
 * the busy endpoint (observed 2026-08-29: 24 attempts across 6 accounts in
 * ~7 minutes, all identical 503s). Default cap: 2 busy rotations (3 accounts
 * total); 'off' disables the cap.
 */
export function qwenAiBusyFailoverRotationMaxFromEnv(): number | undefined {
  const raw = String(process.env.CHAT2API_QWEN_AI_BUSY_FAILOVER_ROTATION_MAX ?? '').trim()
  if (raw.toLowerCase() === 'off') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : 2
}

export function createQwenAiBusyFailoverStopRule(
  maxRotations = qwenAiBusyFailoverRotationMaxFromEnv(),
): ((result: ForwardResult, history: readonly ForwardResult[]) => boolean) | undefined {
  if (maxRotations === undefined) return undefined
  return (result, history) => {
    if (result.errorCode !== 'qwen_ai_upstream_busy') return false
    if (!history.every(prior => prior.errorCode === 'qwen_ai_upstream_busy')) return false
    return history.length > maxRotations
  }
}
