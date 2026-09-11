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
  '让我|我先|我来|我先来|我现在|我会|我将|接下来|现在让|好的[，,]?我|可以[，,]?我|嗯[，,]?我|我需要',
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
  // Session-long capability-denial narratives (2026-09-10 incident: the model
  // spent 100+ turns claiming "the exec_command tool is currently unavailable
  // in this environment" while every executed call succeeded). These phrasings
  // assert the MANAGED tools are absent — never a legitimate tool-result
  // report, because tool results arrive through the result channel, not prose.
  "tool[s]? (?:is|are|was|were) (?:currently )?unavailable",
  "unavailable in this (?:environment|session|turn)",
  "once [^\\n.]{0,60}?become[s]? available",
  "retry in a new turn where [^\\n.]{0,60}?(?:is |are )?available",
  "[\"'`]?(?:is|are)(?: [a-z]+){0,2}? returning [\"'`]?does not exists",
  "我(?:没有|无法|不能)(?:访问|调用|使用)(?:该|这个|任何)?工具",
  // Chinese variants insert modifiers between the noun and the denial
  // ("工具在当前环境中不可用"), so the gap is tolerated instead of requiring
  // adjacency.
  "工具[^，。\\n]{0,12}?(?:不可用|不存在|无法访问|无法使用)",
  "(?:无法|不能)在此环境中",
  // "当工具恢复可用时我可以…" asserts current unavailability while promising a
  // later retry — a denial claim by construction.
  "工具[^，。\\n]{0,12}?恢复可用",
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
 * A short answer that terminates in a colon (ASCII or fullwidth) promises an
 * enumeration, command, code block, or tool call that is not present — a
 * structural dangling signal independent of the opener wording. Observed live
 * 2026-09-11 (GLM-5.3-Flash first turn via codex): the model answered
 * "可以在本地 Codex 会话存储里找一下，我用这个 UUID 搜文件名和内容：" and ended
 * the turn; no opener matched ("我用…" is not an intent opener), no tool call,
 * no rejected block, so the promise prose was delivered and the client turn
 * stopped silently. Length cap mirrors the progress-intent cap: substantive
 * complete answers do not end on a colon. Callers pass trimmed content.
 */
export function isColonTerminatedShortAnswer(trimmedContent: string): boolean {
  if (!trimmedContent || trimmedContent.length > MANAGED_PROGRESS_INTENT_MAX_CODE_POINTS) return false
  return /[:：]\s*$/u.test(trimmedContent)
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

export interface ManagedToolDenialClaim {
  /** Index of the first character of the denial claim. */
  index: number
  /** Index of the first character AFTER the denial claim. */
  end: number
}

/**
 * Unanchored, length-cap-free denial-claim locator for stream hold-back: the
 * 2026-09-10 incident showed denial claims sitting mid-message (after legit
 * analysis prose, before a dumped code payload AND a valid tool call), which
 * the capped first-paragraph classifier cannot see. Returns the FIRST claim
 * occurrence so the caller can hold everything from it onward.
 */
export function findManagedToolDenialClaim(text: string): ManagedToolDenialClaim | undefined {
  if (!text) return undefined
  const regex = managedToolDenialRegex()
  if (!regex) return undefined
  const match = regex.exec(text)
  if (!match) return undefined
  return { index: match.index, end: match.index + match[0].length }
}
