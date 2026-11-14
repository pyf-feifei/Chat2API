import type { Account } from '../../shared/types'

export interface QwenAiServiceRecoveryState {
  deadlineAt: number
  browserAttempts: number
  maxBrowserAttempts: number
}

function boundedEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || !raw.trim()) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback
}

/** One bounded browser budget for the logical request, including account failover. */
export function createQwenAiServiceRecoveryState(requestDeadlineAt: number): QwenAiServiceRecoveryState {
  return {
    deadlineAt: Math.min(requestDeadlineAt, Date.now() + boundedEnv('CHAT2API_QWEN_AI_SERVICE_RECOVERY_TIMEOUT_MS', 300_000, 900_000)),
    browserAttempts: 0,
    maxBrowserAttempts: boundedEnv('CHAT2API_QWEN_AI_SERVICE_RECOVERY_BROWSER_ATTEMPTS', 2, 4),
  }
}

export function canRecoverQwenAiSession(state: QwenAiServiceRecoveryState, signal?: AbortSignal): boolean {
  return !signal?.aborted && Date.now() < state.deadlineAt
    && state.browserAttempts < state.maxBrowserAttempts
}

async function boundedWait<T>(operation: Promise<T>, deadlineAt: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted || Date.now() >= deadlineAt) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineAt - Date.now()))
    onAbort = () => resolve(undefined)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([operation, stop])
    return signal?.aborted || Date.now() >= deadlineAt ? undefined : result
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Only the browser's verified owning-account result permits a replay. Failed
 * probes may retry verification after cooldown, never the rejected payload.
 * The caller must still validate the actual generation before delivering it.
 */
export async function recoverQwenAiAccountSession(options: {
  accountId: string
  state: QwenAiServiceRecoveryState
  signal?: AbortSignal
  recover: () => Promise<Account | null | undefined> | undefined
  onAttempt?: (attempt: number) => void
}): Promise<Account | undefined> {
  const { state, signal } = options
  while (canRecoverQwenAiSession(state, signal)) {
    if (state.browserAttempts > 0) {
      const delay = boundedEnv('CHAT2API_QWEN_AI_SERVICE_RECOVERY_RETRY_DELAY_MS', 60_000, 300_000)
      // A pending sleep is cleaned up on abort/deadline, not left alive.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await boundedWait(new Promise<void>(resolve => { timer = setTimeout(resolve, delay) }), state.deadlineAt, signal)
      } finally { clearTimeout(timer) }
      if (!canRecoverQwenAiSession(state, signal)) return undefined
    }
    state.browserAttempts += 1
    options.onAttempt?.(state.browserAttempts)
    const result = await boundedWait(Promise.resolve().then(options.recover), state.deadlineAt, signal)
    if (result?.id === options.accountId) return result
    // A foreign result is an identity violation, not a reason to spend more
    // browser attempts or copy credentials. Leave the current account alone.
    if (result && result.id !== options.accountId) return undefined
  }
  return undefined
}
