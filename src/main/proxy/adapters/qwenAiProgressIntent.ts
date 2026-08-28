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
 * A progress-style answer is a SHORT single-paragraph statement announcing
 * intent. Long or multi-paragraph answers are treated as substantive and
 * delivered as-is: agentic clients rarely terminate on them, and overwide
 * matching would turn legitimate summaries into retry loops.
 */
export function isProgressStyleManagedAnswer(trimmedContent: string): boolean {
  if (!trimmedContent || trimmedContent.length > MANAGED_PROGRESS_INTENT_MAX_CODE_POINTS) return false
  if (trimmedContent.includes('\n\n')) return false
  const regex = managedProgressIntentRegex()
  if (!regex) return false
  return regex.test(trimmedContent)
}
