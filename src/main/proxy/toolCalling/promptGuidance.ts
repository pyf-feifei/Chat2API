/**
 * Deployment-tunable prompt guidance shared by the managed protocol prompts.
 * Follows the runtimeRulesFromEnv semantics used across the tool-calling
 * layer: a non-empty env value replaces the default text, the sentinel "off"
 * removes the block entirely, and an invalid value falls back to the default.
 * No client or provider names appear in the defaults: the guidance is
 * protocol-level.
 */

export const LARGE_PAYLOAD_GUIDANCE_RETRY =
  'Very large single-call payloads (multi-kilobyte file content in one parameter) can fail upstream validation; if a call fails or the tool reports it does not exist, retry the SAME operation with a smaller payload split across multiple calls instead of switching to prose.'

export const LARGE_PAYLOAD_GUIDANCE_CHUNking =
  'Very large single-call payloads (multi-kilobyte file content in one parameter) can fail upstream validation; write and patch files with smaller payload chunks across multiple calls.'

const LARGE_PAYLOAD_GUIDANCE_ENV = 'CHAT2API_TOOL_CALLING_LARGE_PAYLOAD_GUIDANCE'

export function largePayloadGuidanceEnabled(): boolean {
  return String(process.env[LARGE_PAYLOAD_GUIDANCE_ENV] ?? '').trim().toLowerCase() !== 'off'
}

/**
 * The upstream platform's tool-registry diagnostic string. When the model's
 * tool-call text is intercepted and replaced by this diagnostic, the text is
 * the platform's own broken-English error shape; the default below tracks
 * that shape and is deployment-tunable in case the upstream wording changes.
 */
const PLATFORM_TOOL_DIAGNOSTIC_ENV = 'CHAT2API_TOOL_CALLING_PLATFORM_TOOL_DIAGNOSTIC'
const PLATFORM_TOOL_DIAGNOSTIC_DEFAULT_SOURCE = 'does not exists'

let cachedPlatformDiagnosticRegex: { source: string; regex: RegExp } | undefined

export function platformToolDiagnosticPattern(): RegExp | undefined {
  const raw = String(process.env[PLATFORM_TOOL_DIAGNOSTIC_ENV] ?? '').trim()
  if (raw.toLowerCase() === 'off') return undefined
  const source = raw || PLATFORM_TOOL_DIAGNOSTIC_DEFAULT_SOURCE
  if (cachedPlatformDiagnosticRegex?.source === source) {
    return cachedPlatformDiagnosticRegex.regex
  }
  let regex: RegExp
  try {
    regex = new RegExp(source, 'i')
  } catch {
    console.warn(`[ToolCalling] Invalid ${PLATFORM_TOOL_DIAGNOSTIC_ENV} regex, falling back to default`)
    regex = new RegExp(PLATFORM_TOOL_DIAGNOSTIC_DEFAULT_SOURCE, 'i')
  }
  cachedPlatformDiagnosticRegex = { source, regex }
  return regex
}
