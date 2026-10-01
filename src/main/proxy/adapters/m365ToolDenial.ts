/**
 * M365-scoped capability-denial detection.
 *
 * The shared table in `qwenAiProgressIntent` is used by every provider, and its
 * wording coverage stops at the phrasings those providers were observed to
 * produce. M365's consumer chat tone produces a different and much broader set
 * (all observed live on 2026-09-29 against gpt-5.6-sol), and the turn-end
 * consequence is the worst kind: a denial delivered to the client as if it were
 * the answer, ending the agent's turn with the work unfinished.
 *
 * Those patterns are therefore kept HERE, not added to the shared table. Adding
 * them there would change denial classification for zai, qwen-ai and mimo, whose
 * measured wordings are unrelated and whose false-positive cost is a wasted
 * round-trip on a correct answer.
 *
 * `CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS` keeps its documented meaning: an
 * explicit value REPLACES the table outright, so a deployment that pins its own
 * patterns gets exactly those and none of the extras below.
 */
import {
  isToolDenialManagedAnswer,
  managedToolDenialRegex,
  type ManagedToolDenialClaim,
} from './qwenAiProgressIntent.ts'

/**
 * Denials this backend was actually observed to produce. Each one reached the
 * client as a delivered answer before it was added, and each one is quoted from
 * a live run.
 */
const M365_TOOL_DENIAL_PATTERN_SOURCES = [
  // "I can't read /etc/hostname from your machine because I don't have access
  //  to the caller's local filesystem"
  // The shared table has the "do not" spelling only, and requires the tool noun
  // immediately after the verb, so this missed.
  "(?:do(?:es)? not|don't|doesn't|didn't|cannot|can't|can not|unable to|am not able to)\\s+(?:have|has|access|use|invoke|call|run|read|write|execute)\\b",
  // "there is no actual `read_file` tool available in my environment"
  // "no file-reading tool for arbitrary local paths is actually available in
  //  this conversation"
  // "no tool available to me in this conversation"
  // A modifier sits between "no" and "tool", and the availability word may have
  // no copula before it, which the shared `no (such )?tool …` pattern requires.
  "no[^.\\n]{0,40}?tools?[^.\\n]{0,30}?(?:(?:is|are|was|were)[^.\\n]{0,20}?)?(?:available|accessible|present|exposed|enabled|provided)",
  "no tool[^.\\n]{0,40}?(?:to me|for me)\\b",
  // "there is no actual `read_file` tool" / "no file-access tool exposed here"
  "(?:there is|there's)\\s+no[^.\\n]{0,40}?tool\\b",
  // "the tools are not wired up in this chat", "tools aren't connected"
  "tools?[^.\\n]{0,20}?(?:are|is|aren't|isn't|were not|was not)[^.\\n]{0,20}?(?:wired|connected|hooked|enabled|available|connected up)",
].join('|')

const DENIAL_PATTERNS_ENV = 'CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS'

let cachedM365DenialRegex: { source: string; regex: RegExp } | undefined

/**
 * Shared table plus the M365 extras. An explicit env override wins outright, so
 * pinning the shared table keeps the documented "exactly these patterns"
 * behaviour instead of silently re-adding the extras.
 */
export function m365ToolDenialRegex(): RegExp | undefined {
  const shared = managedToolDenialRegex()
  if (!shared) return undefined
  const override = String(process.env[DENIAL_PATTERNS_ENV] ?? '').trim()
  const source = override ? shared.source : `${shared.source}|${M365_TOOL_DENIAL_PATTERN_SOURCES}`
  if (cachedM365DenialRegex?.source === source) return cachedM365DenialRegex.regex
  let regex: RegExp
  try {
    regex = new RegExp(source, 'i')
  } catch {
    console.warn('[M365Copilot] Invalid denial pattern composition, falling back to the shared table')
    regex = shared
  }
  cachedM365DenialRegex = { source, regex }
  return regex
}

/** Length-capped, first-paragraph denial test, mirroring the shared helper. */
export function isM365ToolDenialManagedAnswer(trimmedContent: string): boolean {
  if (isToolDenialManagedAnswer(trimmedContent)) return true
  if (!trimmedContent) return false
  const regex = m365ToolDenialRegex()
  if (!regex) return false
  // Typographic apostrophes ("can’t") must be normalized, as in the shared helper.
  const normalized = trimmedContent.replace(/[‘’ʼ]/g, "'")
  return regex.test(normalized.split('\n\n')[0])
}

/** Unanchored, cap-free locator used by the forwarder's continuation decision. */
export function findM365ToolDenialClaim(text: string): ManagedToolDenialClaim | undefined {
  if (!text) return undefined
  // Typographic apostrophes MUST be normalized here. M365's consumer tone emits
  // "I don’t have access to …" (U+2019) far more often than the ASCII form, and
  // no ASCII-spelled pattern can match it. The length-capped classifier already
  // normalizes; this locator did not, so a curly-quote denial went undetected
  // and was delivered as the answer (measured 2026-09-30: 1 leak in 8 turns,
  // the only difference from the caught cases being the apostrophe).
  const normalized = text.replace(/[‘’ʼ]/g, "'")
  const shared = managedToolDenialRegex()
  const own = m365ToolDenialRegex()
  const sharedMatch = shared?.exec(normalized)
  const ownMatch = own && own !== shared ? own.exec(normalized) : undefined
  const candidates = [sharedMatch?.index, ownMatch?.index]
    .filter((value): value is number => value !== undefined)
  if (candidates.length === 0) return undefined
  const index = Math.min(...candidates)
  const match = ownMatch && ownMatch.index === index ? ownMatch : sharedMatch
  if (!match) return undefined
  return { index, end: index + match[0].length }
}
