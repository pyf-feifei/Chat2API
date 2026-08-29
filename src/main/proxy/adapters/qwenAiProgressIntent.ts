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
