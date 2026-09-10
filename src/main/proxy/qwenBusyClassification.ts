/**
 * Busy-family classification for the Qwen AI exit-IP recovery levers (webshare
 * one-shot retry + sticky mode). Kept standalone so tests can import it
 * without forwarder.ts's extensionless import chain.
 */

export interface QwenBusyFamilyResult {
  success: boolean
  errorCode?: string
  accountFault?: boolean
}

export function isQwenAiUpstreamBusyResult(result: QwenBusyFamilyResult): boolean {
  if (result.success) return false
  // Capacity throttling (429 quota_limit "目前服务访问量较大") behaves like the
  // RGV587 busy family at peak: rotating accounts on the same exit IP keeps
  // hitting the same verdict (2026-09-10 evening: 6+ accounts bounced on one
  // exit while light sessions passed), so the exit-IP recovery lever — the
  // Webshare retry — must engage too, regardless of the account-fault flag
  // the rotation path sets.
  if (result.errorCode === 'qwen_ai_capacity_limit') return true
  return result.errorCode === 'qwen_ai_upstream_busy'
    && result.accountFault === false
}
