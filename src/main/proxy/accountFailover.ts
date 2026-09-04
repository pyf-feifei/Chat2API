import type { AccountSelection, ForwardResult } from './types.ts'
import { markAccountErrorIfPermanent } from './accountStatus.ts'

export interface AccountFailoverAttempt {
  selection: AccountSelection
  attempt: number
}

export interface AccountFailoverOutcome {
  selection: AccountSelection
  result: ForwardResult
  failoverCount: number
  excludedAccountIds: ReadonlySet<string>
}

export interface AccountFailoverLimitInput {
  configuredMaxFailovers: number
  qwenAiProvider: boolean
  activeAccountCount: number
  qwenAiMaxAccountFailovers?: string
}

interface AccountFailoverOptions {
  initialSelection: AccountSelection
  maxFailovers: number
  signal?: AbortSignal
  forward: (attempt: AccountFailoverAttempt) => Promise<ForwardResult>
  selectNext: (excludedAccountIds: ReadonlySet<string>) => AccountSelection | null
  onFailedAttempt?: (
    attempt: AccountFailoverAttempt,
    result: ForwardResult,
  ) => void | Promise<void>
  /**
   * Optional per-request stop rule consulted before rotating. Receives the
   * current failure and the ordered history of earlier failures in this
   * request, so callers can stop when the SAME rejection keeps coming back
   * across accounts (a content/pattern rejection, not capacity — rotating
   * only hammers the busy upstream harder).
   */
  shouldStopFailover?: (
    result: ForwardResult,
    history: readonly ForwardResult[],
  ) => boolean
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function resolveAccountFailoverLimit(input: AccountFailoverLimitInput): number {
  const configuredMaxFailovers = nonNegativeInteger(input.configuredMaxFailovers)
  if (!input.qwenAiProvider) return configuredMaxFailovers

  const poolMaxFailovers = Math.max(0, nonNegativeInteger(input.activeAccountCount) - 1)
  const deploymentLimit = Number(input.qwenAiMaxAccountFailovers)
  if (!Number.isSafeInteger(deploymentLimit) || deploymentLimit <= 0) {
    return poolMaxFailovers
  }

  return Math.min(poolMaxFailovers, deploymentLimit)
}

export function isNextAccountFailoverEligible(
  result: ForwardResult,
  signal?: AbortSignal,
): boolean {
  return !result.success
    && result.retryScope === 'next-account'
    && result.status !== 499
    && signal?.aborted !== true
}

// The qwen busy-failover stop rule lives in qwenBusyFailover.ts so test
// harnesses can import it without this module's accountStatus dependency.

export async function forwardWithAccountFailover(
  options: AccountFailoverOptions,
): Promise<AccountFailoverOutcome> {
  const maxFailovers = Math.max(0, Math.floor(options.maxFailovers))
  let selection = options.initialSelection
  let failoverCount = 0
  let excludedAccountIds: ReadonlySet<string> = new Set()
  const failureHistory: ForwardResult[] = []

  while (true) {
    const attempt = { selection, attempt: failoverCount + 1 }
    const result = await options.forward(attempt)
    markAccountErrorIfPermanent(result, selection.account.id, selection.provider.id)

    if (
      !isNextAccountFailoverEligible(result, options.signal)
      || failoverCount >= maxFailovers
      || options.shouldStopFailover?.(result, failureHistory) === true
    ) {
      return { selection, result, failoverCount, excludedAccountIds }
    }

    failureHistory.push(result)

    const nextExcludedAccountIds = new Set([
      ...excludedAccountIds,
      selection.account.id,
    ])
    const nextSelection = options.selectNext(nextExcludedAccountIds)
    if (!nextSelection) {
      return {
        selection,
        result,
        failoverCount,
        excludedAccountIds: nextExcludedAccountIds,
      }
    }

    await options.onFailedAttempt?.(attempt, result)
    selection = nextSelection
    excludedAccountIds = nextExcludedAccountIds
    failoverCount += 1
  }
}
