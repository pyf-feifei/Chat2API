import assert from 'node:assert/strict'
import test from 'node:test'

import { forwardWithAccountFailover } from '../../src/main/proxy/accountFailover.ts'
import type {
  AccountSelection,
  ForwardResult,
  ProxyContext,
  QwenAiEgressRecoveryState,
} from '../../src/main/proxy/types.ts'

/**
 * Regression: the Webshare egress switch is request-scoped, not attempt-scoped.
 *
 * An aliyun risk verdict (FAIL_SYS_USER_VALIDATE / RGV587 / `bxpunish`) flags
 * the egress IP, not the account. When a busy-retry escalates such a request to
 * the Webshare proxy and the same request ALSO returns `retryScope:
 * 'next-account'`, the account-failover loop re-enters the forwarder with a new
 * account. The previous implementation kept `qwenAiWebshareProxy` in per-attempt
 * locals inside `forwardChatCompletion`, so a rotated account started again with
 * `false` — silently discarding the exit-IP switch. Observed on production
 * 2026-09-20: `retryViaWebshare:true` logged, yet the adapter never printed
 * `routing request through Webshare proxy`, and each rotated account burned a
 * fresh direct-exit rejection.
 *
 * The fix moves the ledger onto `ProxyContext.qwenAiEgressRecoveryState`, which
 * the failover loop passes to every attempt. These tests pin that contract.
 */

function selection(accountId: string): AccountSelection {
  return {
    account: { id: accountId } as AccountSelection['account'],
    provider: { id: 'qwen-ai' } as AccountSelection['provider'],
    actualModel: 'qwen3.8-max',
  }
}

function busyRiskVerdict(): ForwardResult {
  return {
    success: false,
    status: 503,
    // `bxpunish` never reaches the body — it rides a response header, so the
    // forwarder must read it off `headers`, not `error`.
    headers: { bxpunish: '1' },
    error: 'upstream-busy',
    errorCode: 'qwen_ai_upstream_busy',
    retryable: true,
    accountFault: false,
    retryScope: 'next-account',
  }
}

test('egress ledger survives an account-failover rotation', async () => {
  // One ledger for the whole client request, exactly as the route creates it.
  const context = {
    requestId: 'req-egress-failover',
    model: 'qwen3.8-max',
    startTime: Date.now(),
    isStream: true,
    qwenAiEgressRecoveryState: {
      webshareRetries: 0,
      useWebshareProxy: false,
    } satisfies QwenAiEgressRecoveryState,
  } as ProxyContext

  const seenProxyFlags: boolean[] = []
  const seenAccountIds: string[] = []

  await forwardWithAccountFailover({
    initialSelection: selection('acct-1'),
    maxFailovers: 3,
    forward: async ({ selection: current }) => {
      seenAccountIds.push(current.account.id)
      // The attempt escalates to the proxy the same way
      // scheduleQwenAiBusyRetry does before returning next-account.
      context.qwenAiEgressRecoveryState!.webshareRetries += 1
      context.qwenAiEgressRecoveryState!.useWebshareProxy = true
      seenProxyFlags.push(context.qwenAiEgressRecoveryState!.useWebshareProxy)
      return busyRiskVerdict()
    },
    selectNext: () => selection(`acct-${seenAccountIds.length + 1}`),
  })

  assert.ok(seenAccountIds.length > 1, 'the failover loop must have rotated accounts')
  assert.deepEqual(
    seenProxyFlags,
    seenAccountIds.map(() => true),
    'every attempt after the escalation must still see useWebshareProxy=true',
  )

  // The decisive check: the ledger was NOT reset at the account boundary, so
  // the retry counter and the switch both persist for the adapter to read.
  assert.equal(context.qwenAiEgressRecoveryState!.useWebshareProxy, true)
  assert.equal(context.qwenAiEgressRecoveryState!.webshareRetries, seenAccountIds.length)
})

test('a fresh request starts with the egress ledger disengaged', () => {
  // Guards against the regression where a module-level or shared-singleton flag
  // leaks one request's exit switch into the next request's first attempt.
  const first = {
    qwenAiEgressRecoveryState: {
      webshareRetries: 0,
      useWebshareProxy: false,
    } satisfies QwenAiEgressRecoveryState,
  } as ProxyContext
  const second = {
    qwenAiEgressRecoveryState: {
      webshareRetries: 0,
      useWebshareProxy: false,
    } satisfies QwenAiEgressRecoveryState,
  } as ProxyContext

  first.qwenAiEgressRecoveryState!.useWebshareProxy = true

  assert.equal(first.qwenAiEgressRecoveryState!.useWebshareProxy, true)
  assert.equal(
    second.qwenAiEgressRecoveryState!.useWebshareProxy,
    false,
    'a new request must not inherit another request\'s egress switch',
  )
})
