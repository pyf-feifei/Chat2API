/**
 * Progress-intent detection for managed tool workflows: short answers that
 * announce an upcoming action ("Let me check…", "让我检查…") without a tool
 * call or completion proof end agentic client turns silently. Kept as a
 * standalone module so tests can import it without the adapter's
 * extensionless-import chain.
 *
 * Patterns are deployment-tunable via
 * CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS ("|" separated regex sources,
 * case-insensitive, anchored at start; "off" disables detection entirely).
 * The default covers common English/Chinese intent openers; only short,
 * single-paragraph statements match so substantive answers stay deliverable.
 */
// The opener word-list is an ASSISTANCE layer only. The authoritative
// protection is structural: a marker-less short answer over a live tool
// workflow classifies as dangling regardless of wording (see
// MANAGED_SHORT_ANSWER_CODE_POINTS in the adapter). Keep this list minimal —
// generic intent openers only; do not chase incident-specific phrasings here
// (deployment-tunable via CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS if a site
// wants more).
const MANAGED_PROGRESS_INTENT_DEFAULT_PATTERN_SOURCES = [
  "let me|let's|lets ",
  "i'll|i will|i am going to|i'm going to|i need to|i've (?:got|have) to",
  "now let me|first,? let me|first,? i'll|first,? i will",
  "ok(?:ay)?[,.]? (?:let|i'll|i will)|sure[,.]? (?:let|i'll)",
  '让我|我先|我来|我先来|我现在|接下来|现在让|好的[，,]?我|可以[，,]?我|嗯[，,]?我|我需要',
].join('|')

const MANAGED_PROGRESS_INTENT_MAX_CODE_POINTS = 300

let cachedProgressIntentRegex: { sources: string; regex: RegExp } | undefined

export function managedProgressIntentRegex(): RegExp | undefined {
  const raw = String(process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS ?? '').trim()
  if (raw.toLowerCase() === 'off') return undefined
  const sources = raw || MANAGED_PROGRESS_INTENT_DEFAULT_PATTERN_SOURCES
  if (cachedProgressIntentRegex?.sources === sources) {
    return cachedProgressIntentRegex.regex
  }
  let regex: RegExp
  try {
    regex = new RegExp(`^(?:${sources})`, 'i')
  } catch {
    console.warn('[QwenAI] Invalid CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS regex, falling back to defaults')
    regex = new RegExp(`^(?:${MANAGED_PROGRESS_INTENT_DEFAULT_PATTERN_SOURCES})`, 'i')
  }
  cachedProgressIntentRegex = { sources, regex }
  return regex
}

/**
 * A progress-style answer is a SHORT statement announcing or acknowledging
 * intent. The opener is matched against the FIRST paragraph only: observed
 * acknowledgment variants (理解！…现在开始执行) open with the intent
 * declaration and then lay out a numbered plan with blank lines, which the
 * previous whole-content single-paragraph rule never saw. The total-length
 * cap still bounds overmatching: long multi-section answers are substantive
 * and stay deliverable.
 */
export function isProgressStyleManagedAnswer(trimmedContent: string): boolean {
  if (!trimmedContent || trimmedContent.length > MANAGED_PROGRESS_INTENT_MAX_CODE_POINTS) return false
  const regex = managedProgressIntentRegex()
  if (!regex) return false
  const firstParagraph = trimmedContent.split('\n\n')[0]
  return regex.test(firstParagraph)
}

// Capability-denial detection: at very large contexts the model occasionally
// answers that a client-declared tool "is not available" / "cannot be
// accessed" (or announces it is fetching data through some other channel)
// even though the managed contract just declared the tool. Such an answer
// neither calls the tool nor completes the workflow, so it is a dangling
// stall. Unlike intent openers, denial phrasing can sit mid-sentence, so the
// patterns test the first paragraph UNANCHORED. Patterns are
// deployment-tunable via CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS ("|" separated
// regex sources, case-insensitive, tested against the first paragraph; "off"
// disables detection entirely).
const MANAGED_TOOL_DENIAL_DEFAULT_PATTERN_SOURCES = [
  "i do not (?:have|currently have) access to",
  "(?:do(?:es)? not|don't|doesn't|cannot|can't|unable to) (?:use|invoke|call|access) (?:the|any|this|your) (?:tool|function)",
  "not (?:currently )?available in my (?:current )?(?:toolset|tool set|set of tools|environment)",
  "no (?:such )?tool (?:is )?(?:available|defined|declared|registered)",
  "tool (?:is )?not (?:available|accessible|defined|declared)",
  "tool (?:call was )?(?:skipped|omitted|dropped) because",
  "我(?:没有|无法|不能)(?:访问|调用|使用)(?:该|这个|任何)?工具",
  "工具(?:不可用|不存在|无法访问)",
  'i am (?:currently )?(?:retrieving|fetching|consulting)',
  '正在(?:检索|获取|查询)实时',
].join('|')

let cachedToolDenialRegex: { sources: string; regex: RegExp } | undefined

export function managedToolDenialRegex(): RegExp | undefined {
  const raw = String(process.env.CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS ?? '').trim()
  if (raw.toLowerCase() === 'off') return undefined
  const sources = raw || MANAGED_TOOL_DENIAL_DEFAULT_PATTERN_SOURCES
  if (cachedToolDenialRegex?.sources === sources) {
    return cachedToolDenialRegex.regex
  }
  let regex: RegExp
  try {
    regex = new RegExp(sources, 'i')
  } catch {
    console.warn('[QwenAI] Invalid CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS regex, falling back to defaults')
    regex = new RegExp(MANAGED_TOOL_DENIAL_DEFAULT_PATTERN_SOURCES, 'i')
  }
  cachedToolDenialRegex = { sources, regex }
  return regex
}

/**
 * A capability-denial answer claims the declared tools are unavailable (or
 * that data is being fetched some other way) without a tool call. Length cap
 * mirrors the progress-intent cap: substantive answers that actually complete
 * the request are longer and stay deliverable.
 */
export function isToolDenialManagedAnswer(trimmedContent: string): boolean {
  if (!trimmedContent || trimmedContent.length > MANAGED_PROGRESS_INTENT_MAX_CODE_POINTS) return false
  const regex = managedToolDenialRegex()
  if (!regex) return false
  const firstParagraph = trimmedContent.split('\n\n')[0]
  return regex.test(firstParagraph)
}
