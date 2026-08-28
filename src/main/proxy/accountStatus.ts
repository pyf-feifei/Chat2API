/**
 * Persistent account fault marking.
 *
 * When a provider reports an authentication/credential/ban class failure the
 * account is switched to `error` status (with the upstream message) so the
 * management UI shows which account is broken instead of listing it as
 * active. Transient failures (rate limits, content policy, 5xx, transport)
 * never change the status.
 */
import { storeManager } from '../store/store'
import type { ForwardResult } from './types'

const TRANSIENT_FAULT_TEXT =
  /content (policy|filter)|safety system|rate ?limit|too many requests|quota|insufficient balance|busy|chat in progress|timeout|timed out|connection|socket|network|econnreset|econnrefused|enotfound|eai_again|internal (server )?error|bad gateway|service unavailable|gateway timeout|temporary|transient|overloaded/i

const PERMANENT_FAULT_TEXT =
  /invalid_grant|aadsts|service abuse|abuse mode|account (is )?(suspended|disabled|blocked|banned|closed|deleted)|user (is )?(suspended|banned|blocked)|risk control|risk_control|blacklist|forbidden|access denied|unauthorized|invalid (api[ _-]?key|key|token|credential|signature)|signature (does not match|mismatch)|(api[ _-]?key|token|credential|cookie) (is )?(invalid|expired|revoked|not valid)|authentication (failed|error)|permission denied/i

// Qwen Web sessions self-heal through the session-repair daemon, so only an
// explicit ban/suspension may flip the account out of the active pool.
const QWEN_PERMANENT_FAULT_TEXT =
  /account (is )?(suspended|disabled|blocked|banned)|user (is )?(suspended|banned|blocked)|risk control|risk_control|blacklist|forbidden|permission denied/i

export function isPermanentAccountFault(
  result: ForwardResult | undefined,
  providerId?: string,
): boolean {
  if (!result || result.success) return false
  if (result.accountFault === false) return false
  const status = typeof result.status === 'number' ? result.status : undefined
  if (status !== undefined && status >= 500) return false
  const text = `${result.error ?? ''} ${result.errorCode ?? ''}`
  if (TRANSIENT_FAULT_TEXT.test(text)) return false
  if (providerId === 'qwen-ai') return QWEN_PERMANENT_FAULT_TEXT.test(text)
  if (status === 401) return true
  return (
    PERMANENT_FAULT_TEXT.test(text) &&
    (status === undefined || (status >= 400 && status < 500))
  )
}

export function markAccountErrorIfPermanent(
  result: ForwardResult | undefined,
  accountId: string,
  providerId?: string,
): void {
  if (!accountId || !isPermanentAccountFault(result, providerId)) return
  const account = storeManager.getAccountById(accountId, true)
  if (!account || account.status !== 'active') return
  const message = String(
    result.error || result.errorCode || 'Upstream authentication failure',
  ).slice(0, 500)
  storeManager.updateAccount(accountId, { status: 'error', errorMessage: message })
  console.warn(`[AccountStatus] account ${accountId} marked as error: ${message}`)
}
