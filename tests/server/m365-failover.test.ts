import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * M365 account-failover classification tests.
 *
 * The route-level failover loop (accountFailover.ts) is provider-generic;
 * entering it requires result.retryScope === 'next-account'. These tests pin
 * the M365 failure-return contract: auth-class failures carry the rotate
 * marker, everything else stays account-neutral.
 */
import { isM365AuthIssue, m365FailureClassification } from '../../src/main/proxy/m365FailoverClassification.ts'

test('auth-class errors are account-scoped', () => {
  for (const message of [
    'WebSocket error: Unexpected server response: 401',
    'invalid_grant: AADSTS70000: service abuse mode',
    'WebSocket error: Unexpected server response: 403',
    'M365 access token expired; re-authenticate this account',
  ]) {
    assert.ok(isM365AuthIssue(message), message)
    const c = m365FailureClassification(new Error(message))
    assert.equal(c.retryScope, 'next-account', message)
    assert.equal(c.status, 401, message)
    assert.equal(c.accountFault, true, message)
    assert.equal(c.retryable, false, message)
  }
})

test('transport/content failures stay account-neutral', () => {
  for (const message of [
    'ChatHub timeout',
    'WebSocket closed before completion: code=1006',
    'Content filter triggered',
    'rate limit exceeded',
    'too many requests',
  ]) {
    const c = m365FailureClassification(new Error(message))
    assert.notEqual(c.retryScope, 'next-account', message)
    assert.notEqual(c.accountFault, true, message)
  }
})

test('encrypted-credential config error fails over to another account', () => {
  // A container missing the storage key poisons ONLY its own view of every
  // account; the 9002313 incident showed this must not strand the request.
  const c = m365FailureClassification(
    new Error('M365 credentials are still encrypted: CHAT2API_STORAGE_ENCRYPTION_KEY is not set'),
  )
  assert.equal(c.retryScope, 'next-account')
  assert.equal(c.accountFault, true)
})

test('daily-quota wall text is classified as a quota failure', async () => {
  const { isM365QuotaWall } = await import('../../src/main/proxy/m365FailoverClassification.ts')
  assert.ok(isM365QuotaWall("You've reached your daily chat limit, get more chats at example.com"))
  assert.ok(isM365QuotaWall("You've reached your daily limit for chats today"))
  assert.ok(!isM365QuotaWall('The population of Tokyo is 14 million'))
  assert.ok(!isM365QuotaWall(undefined))
  assert.ok(!isM365QuotaWall(''))
})
