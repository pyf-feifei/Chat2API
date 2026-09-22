import type { ForwardResult } from './types'

// Content-determined failures: the request's own payload or protocol shape
// causes the rejection, so replaying the same content on another account
// reproduces it (observed 2026-09-07: one 49K-token request failed 422
// qwen_ai_semantic_incomplete on five different accounts, then the retry
// storm tripped IP-level risk control; the same day an 84K-token transcript
// failed qwen_ai_file_parse_timeout on six consecutive accounts, each
// burning the full 120s parse budget — an unparsed upload is decided by the
// payload, not the account). Deliberately narrower than
// QWEN_AI_ACCOUNT_NEUTRAL_REPLAY_CODES: transient/capacity codes
// (upstream_busy, chat_in_progress, queue_timeout, upload_sts) keep their
// own retry budgets and the busy stop rule, and a single occurrence can be
// capacity rather than content.
const QWEN_AI_CONTENT_FAILURE_ROTATION_CODES = new Set([
  'qwen_ai_semantic_incomplete',
  'qwen_ai_semantic_empty',
  'qwen_ai_wrapper_leak',
  'qwen_ai_invalid_tool_arguments',
  'undeclared_native_tool_call',
  'malformed_tool_call',
  'missing_tool_call',
  'qwen_ai_file_parse_timeout',
  // HTTP-level parse rejection (502/503/504 from the /files/parse gateway):
  // same pipeline-decided family as the timeout above, and the stop rule must
  // cap the escape rotation the same way (observed 2026-09-10: one account's
  // parse hung ~59s → 504 while the next account parsed the identical
  // transcript in 39s).
  'qwen_ai_file_parse_http_error',
])

export function isQwenAiContentDeterminedFailure(result: ForwardResult): boolean {
  return QWEN_AI_CONTENT_FAILURE_ROTATION_CODES.has(result.errorCode ?? '')
    && result.accountFault === false
}

/**
 * Stop rule for the content-failure pattern: when EVERY failure in this
 * request has been a content-determined account-neutral 422, the rejection
 * follows the request content, not the account. The shared replay slot
 * already caps state-threaded routes at one account-neutral replay, so the
 * rule mostly confirms that boundary and protects untagged paths (the
 * anthropic route threads no recovery state). Default cap: 0 extra rotations
 * beyond the shared replay (2 accounts total — the second account is the
 * last cheap branch, model behavior is account-correlated, and the terminal
 * 422 then reaches the client instead of burning the pool). 'off' disables;
 * the comparison shape matches the busy rule (cap N = at most N+1 extra
 * rotations).
 */
export function qwenAiContentFailoverRotationMaxFromEnv(): number | undefined {
  const raw = String(process.env.CHAT2API_QWEN_AI_CONTENT_FAILOVER_ROTATION_MAX ?? '').trim()
  if (raw.toLowerCase() === 'off') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function createQwenAiContentFailoverStopRule(
  maxRotations = qwenAiContentFailoverRotationMaxFromEnv(),
): ((result: ForwardResult, history: readonly ForwardResult[]) => boolean) | undefined {
  if (maxRotations === undefined) return undefined
  return (result, history) => {
    if (!isQwenAiContentDeterminedFailure(result)) return false
    if (!history.every(prior => isQwenAiContentDeterminedFailure(prior))) return false
    return history.length > maxRotations
  }
}

/**
 * `forwardWithAccountFailover` accepts a single `shouldStopFailover` slot, so
 * routes compose the busy and content rules here. An empty or all-disabled
 * list yields undefined so the failover loop keeps its original behavior.
 */
export function combineQwenAiFailoverStopRules(
  ...rules: Array<((result: ForwardResult, history: readonly ForwardResult[]) => boolean) | undefined>
): ((result: ForwardResult, history: readonly ForwardResult[]) => boolean) | undefined {
  const active = rules.filter((rule): rule is NonNullable<typeof rule> => rule !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return (result, history) => active.some(rule => rule(result, history))
}
