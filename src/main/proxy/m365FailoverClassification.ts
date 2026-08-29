/**
 * M365 Copilot failure classification.
 *
 * The route-level account-failover loop is provider-generic and rotates only
 * when a failed ForwardResult carries retryScope 'next-account'. Auth-class
 * ChatHub failures are account-scoped (rotating token/credential state on
 * THIS account); transport and content-policy failures are not.
 */

export function isM365AuthIssue(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/rate limit|too many requests|content policy|contentfilter|safetyblocked/i.test(message)) {
    return false
  }
  return /401|403|unauthorized|access token|token expired|expired token|invalid_grant|aadsts/i.test(message)
}

const M365_QUOTA_WALL_RE = /daily chat limit|get more chats|you'?ve reached your (daily )?(chat )?limit/i

/**
 * Consumer Copilot reports exhausted daily quotas as ordinary answer text
 * ("You've reached your daily chat limit, get more chats..."). Detect the
 * wall so the account can be rotated instead of handing the notice to the
 * client as if it were the model's answer.
 */
export function isM365QuotaWall(text: string | undefined | null): boolean {
  if (!text) return false
  return M365_QUOTA_WALL_RE.test(text)
}

export interface M365FailureClassification {
  status: number | undefined
  retryable: boolean | undefined
  retryScope: 'next-account' | undefined
  accountFault: boolean | undefined
}

export function m365FailureClassification(error: unknown): M365FailureClassification {
  const message = error instanceof Error ? error.message : String(error)
  // Undecryptable credentials poison only this account's stored view; let
  // the route rotate rather than stranding the request (the 2026-08-28
  // AADSTS9002313 false-revocation incident showed how this strands a pool).
  if (message.includes('credentials are still encrypted')) {
    return { status: 401, retryable: false, retryScope: 'next-account', accountFault: true }
  }
  const authIssue = isM365AuthIssue(error)
  if (!authIssue) {
    return { status: undefined, retryable: undefined, retryScope: undefined, accountFault: undefined }
  }
  return {
    status: 401,
    retryable: false,
    retryScope: 'next-account',
    accountFault: true,
  }
}
