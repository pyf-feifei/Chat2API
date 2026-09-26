/**
 * Reasoning-depth directives for chat.qwen.ai.
 *
 * Verified against the live upstream on 2026-09-25 with Qwen3.8-Max and a fixed
 * non-trivial task, n=3..5 per condition (reasoning_content characters):
 *
 *   low  (Fast)                                  0, 0, 0, 0
 *   low  (Fast) + deep directive                 0, 0, 0        <- a prompt
 *                                                                cannot switch
 *                                                                the reasoning
 *                                                                phase on
 *   medium (Auto)                                ~5.2k
 *   high   (Auto)                                ~4.5k
 *   xhigh  (Thinking)                            ~3.5k          <- "Thinking"
 *                                                                is NOT deeper
 *                                                                than "Auto"
 *   high   (Auto) + deep directive               ~21k
 *
 * Two consequences drive this module:
 *
 *  1. The upstream `thinking_mode` enum is only an on/off switch, and the
 *     "Thinking" member is not a deeper tier than "Auto" - it is a structured
 *     reasoning phase that is usually *shorter*. Depth therefore cannot come
 *     from the enum and must not be mapped onto it.
 *  2. A prompt-side directive is a real and repeatable depth multiplier (~4-5x)
 *     but it only works while the reasoning phase is enabled.
 *
 * So the deployment splits the two jobs: `thinking_mode` decides whether the
 * model thinks at all, and this directive decides how much it thinks. Because a
 * deep directive multiplies generation time, it stays off for managed
 * tool-calling turns, where a long reasoning phase adds latency without making
 * the protocol tool call any better.
 */

export type QwenAiDepthTier = 'light' | 'medium' | 'deep'

/**
 * Where the directive is written.
 *
 * 'user' (default) prepends it to the user turn. The upstream applies
 * `system_message` per *chat*, so a per-request effort written there sticks to
 * every later turn of the same chat and can no longer be lowered. The user turn
 * is request-scoped, so effort changes take effect on the very next turn.
 *
 * 'native' merges it into the upstream `system_message` field. That reads more
 * naturally to the model - the directive is no longer "something the user said"
 * - which matters for clients that pin one effort for a whole session (Codex
 * sends `high` throughout), where the sticky-field problem cannot occur. It
 * also stops the directive from nudging the model toward the tool names it saw
 * in the transcript. The price is request-scoped accuracy, so deployments
 * should pick it only when effort is stable.
 */
export type QwenAiDepthPromptChannel = 'user' | 'native'

const DEFAULT_DEPTH_DIRECTIVES: Record<QwenAiDepthTier, string> = {
  light: 'Before answering, reason step by step and verify each step.',
  medium: 'Before answering, work the problem through thoroughly: enumerate the relevant cases, verify each intermediate result, and confirm the conclusion with an independent check.',
  deep: 'Before answering, reason at maximum depth: enumerate the full space of cases, derive and prove an invariant or general rule, verify the result with at least two independent methods, and state the assumptions you relied on. Do not shortcut any step.',
}

/** Effort -> depth tier. Efforts with no tier keep the model's own default. */
const DEFAULT_EFFORT_TIER_MAP = 'medium:light,high:medium,xhigh:deep,ultracode:deep,max:deep'

let warnedUnknownDepthMap = false

function positiveEnvFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || String(raw).trim() === '') return fallback
  const value = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

/**
 * Deployment master switch. On by default because the directive is the only
 * working depth control; set CHAT2API_QWEN_AI_EFFORT_PROMPT=false to restore
 * plain effort -> thinking_mode mapping.
 */
export function qwenAiDepthPromptEnabled(): boolean {
  return positiveEnvFlag('CHAT2API_QWEN_AI_EFFORT_PROMPT', true)
}

/**
 * Effort -> tier map, overridable with
 * `CHAT2API_QWEN_AI_EFFORT_DEPTH_MAP="medium:light,high:deep,..."`.
 * An entirely malformed value falls back to the default table rather than
 * failing the request; a tier outside light|medium|deep is ignored.
 */
export function qwenAiEffortDepthMapFromEnv(): Record<string, QwenAiDepthTier> {
  const raw = String(process.env.CHAT2API_QWEN_AI_EFFORT_DEPTH_MAP ?? '').trim()
  const table: Record<string, QwenAiDepthTier> = {}
  let accepted = false
  if (raw) {
    for (const entry of raw.split(',')) {
      const [effort, tier] = entry.split(':').map(part => part.trim().toLowerCase())
      if (!effort || !tier) continue
      if (tier !== 'light' && tier !== 'medium' && tier !== 'deep') continue
      table[effort] = tier
      accepted = true
    }
    if (!accepted && !warnedUnknownDepthMap) {
      warnedUnknownDepthMap = true
      console.warn(`[QwenAI] Invalid CHAT2API_QWEN_AI_EFFORT_DEPTH_MAP=${raw}, using default mapping`)
    }
  }
  if (!accepted) {
    for (const entry of DEFAULT_EFFORT_TIER_MAP.split(',')) {
      const [effort, tier] = entry.split(':')
      table[effort] = tier as QwenAiDepthTier
    }
  }
  return table
}

export function qwenAiDepthDirectiveText(tier: QwenAiDepthTier): string {
  const override = String(
    process.env[`CHAT2API_QWEN_AI_DEPTH_PROMPT_${tier.toUpperCase()}`] ?? '',
  ).trim()
  return override || DEFAULT_DEPTH_DIRECTIVES[tier]
}

export interface QwenAiDepthDirectiveOptions {
  /** Client effort, snake_case or camelCase, as received. */
  reasoningEffort?: string | null
  /**
   * Resolved upstream thinking switch. A directive is pointless while the
   * reasoning phase is off - measured: Fast + deep directive is still 0 - and
   * a client that asked for no thinking must not get a thinking prompt.
   */
  thinkingEnabled: boolean
  /**
   * Explicit `_Fast` / `_Thinking` suffix, or a managed tool-calling turn. The
   * client pinned the mode deliberately and the depth is not ours to change.
   */
  modePinned: boolean
  managedToolCalling?: boolean
}

/**
 * Resolve the prompt-side depth directive, or undefined when none applies.
 * Returns undefined for a disabled deployment, an effort without a tier, a
 * disabled reasoning phase, a pinned mode, and managed tool-calling turns.
 */
export function resolveQwenAiDepthDirective(
  options: QwenAiDepthDirectiveOptions,
): string | undefined {
  if (!qwenAiDepthPromptEnabled()) return undefined
  if (!options.thinkingEnabled) return undefined
  if (options.modePinned) return undefined
  if (options.managedToolCalling === true) return undefined
  const effort = options.reasoningEffort?.trim().toLowerCase()
  if (!effort) return undefined
  const tier = qwenAiEffortDepthMapFromEnv()[effort]
  if (!tier) return undefined
  return qwenAiDepthDirectiveText(tier)
}

let warnedUnknownDepthChannel = false

/**
 * Requested directive channel. Unknown values are treated as a typo'd opt-in
 * and fail over to the proven 'user' path instead of silently switching a
 * deployment to the sticky native field.
 */
export function qwenAiDepthPromptChannelFromEnv(): QwenAiDepthPromptChannel {
  const raw = String(process.env.CHAT2API_QWEN_AI_DEPTH_PROMPT_CHANNEL ?? '').trim().toLowerCase()
  if (!raw || raw === 'user') return 'user'
  if (raw === 'native') return 'native'
  if (!warnedUnknownDepthChannel) {
    warnedUnknownDepthChannel = true
    console.warn(`[QwenAI] Unknown CHAT2API_QWEN_AI_DEPTH_PROMPT_CHANNEL=${raw}, using "user"`)
  }
  return 'user'
}

const DIRECTIVE_OPEN = '[reasoning-depth]'
const DIRECTIVE_CLOSE = '[/reasoning-depth]'

function directiveBlock(directive: string): string {
  return `${DIRECTIVE_OPEN} ${directive.trim()} ${DIRECTIVE_CLOSE}`
}

function hasDirective(text: string): boolean {
  return typeof text === 'string' && text.includes(DIRECTIVE_OPEN)
}

export interface QwenAiDepthPlacementParams {
  directive: string | undefined
  channel: QwenAiDepthPromptChannel
  userContent: string
  /** Already-extracted native system prompt; '' when the client sent none. */
  systemPrompt: string
  /**
   * The native field's byte cap. Exceeding it makes the extraction path fall
   * back to the flattened transcript, so the directive must respect it too.
   */
  systemPromptMaxBytes?: number
  /**
   * False when the deployment rolled the native system field off (flattened
   * mode, or image generation), or when the client prompt was too large to
   * extract. Writing to a field the deployment disabled would silently
   * re-enable it, so the directive falls back to the user turn.
   */
  nativeSystemAvailable: boolean
}

export interface QwenAiDepthPlacement {
  userContent: string
  systemPrompt: string
  /** Channel the directive actually used, or null when none was applied. */
  usedChannel: QwenAiDepthPromptChannel | null
}

/**
 * Place the depth directive, preferring the requested channel and degrading to
 * the user turn rather than failing or dropping a client system prompt. The
 * marker makes the injection idempotent, so a continuation re-sending the same
 * directive cannot double it.
 */
export function placeQwenAiDepthDirective(
  params: QwenAiDepthPlacementParams,
): QwenAiDepthPlacement {
  const { directive, userContent, systemPrompt, systemPromptMaxBytes, nativeSystemAvailable } = params
  const trimmed = directive?.trim()
  const unchanged: QwenAiDepthPlacement = {
    userContent,
    systemPrompt,
    usedChannel: null,
  }
  if (!trimmed) return unchanged
  if (hasDirective(userContent) || hasDirective(systemPrompt)) return unchanged

  if (params.channel === 'native' && nativeSystemAvailable) {
    const block = directiveBlock(trimmed)
    const merged = systemPrompt ? `${systemPrompt}\n\n${block}` : block
    const overCap = typeof systemPromptMaxBytes === 'number'
      && systemPromptMaxBytes > 0
      && Buffer.byteLength(merged, 'utf8') > systemPromptMaxBytes
    if (!overCap) {
      return { userContent, systemPrompt: merged, usedChannel: 'native' }
    }
    // Over cap: the extraction path would drop the whole client prompt back to
    // the flattened transcript. Do not risk that for a depth directive.
  }

  return {
    userContent: `${directiveBlock(trimmed)}\n\n${userContent}`,
    systemPrompt,
    usedChannel: 'user',
  }
}

/**
 * Prepend the directive to the user turn. Convenience wrapper for callers that
 * only support the user channel; kept for direct use and tests.
 */
export function applyQwenAiDepthDirective(
  content: string,
  directive: string | undefined,
): string {
  const trimmed = directive?.trim()
  const text = typeof content === 'string' ? content : ''
  if (!trimmed) return text
  if (hasDirective(text)) return text
  return `${directiveBlock(trimmed)}\n\n${text}`
}
