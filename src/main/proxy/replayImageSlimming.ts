import type { ChatMessage } from './types'

/**
 * Replays of a long tool session re-upload every embedded image with the
 * transcript. Each uploaded image costs one getstsToken call — and that
 * endpoint is throttled per minute upstream (the official web client never
 * auto-retries it) — while a history carrying dozens of screenshots also
 * trips the upstream risk page (FAIL_SYS_USER_VALIDATE / "被挤爆啦") on
 * every account — observed 2026-08-29: a 433-message replay with ~40
 * embedded images was rejected on all six rotated accounts while the same
 * text-only history passed; observed 2026-08-30: a 355-message turn with
 * 29 file attachments burned the per-minute STS quota mid-turn.
 *
 * Keep only the newest image-bearing messages intact and replace older
 * embedded images with a text placeholder BEFORE the upload stage, so
 * slimmed images never trigger an STS request at all. Client-agnostic:
 * works on generic message structure.
 *
 * Visual-iteration sessions (render → view → adjust loops) need TWO image
 * sets at all times: the earliest attachments hold the ground-truth
 * reference (prototype/screenshot the task is judged against), the newest
 * ones hold the current working renders. Observed 2026-08-30: with
 * keep-last-only slimming (K=3), a turn that viewed the prototype early and
 * then iterated renders 9+ times lost the prototype mid-turn — the model
 * judged fidelity blind and the output stopped matching the reference.
 * So the keep set is FIRST N plus LAST K image-bearing messages. Unique
 * images still upload at most once (47h content-hash cache), so the
 * per-request attachment count stays at N+K regardless of session length.
 *
 * Modes (CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES):
 * - 'on-busy' (default): slim only on rotation replays after an
 *   upstream-busy rejection (the shape that just tripped the risk page).
 * - 'always': slim on the first attempt too. Long visual-iteration sessions
 *   then attach only the newest screenshots, so ordinary turns stay far
 *   below the per-minute STS quota instead of discovering it mid-turn.
 * - 'off': never slim.
 */

export type QwenAiImageSlimMode = 'off' | 'on-busy' | 'always'

export function qwenAiImageSlimModeFromEnv(): QwenAiImageSlimMode {
  const raw = String(process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES ?? '').trim().toLowerCase()
  if (raw === 'off') return 'off'
  if (raw === 'always') return 'always'
  return 'on-busy'
}

/**
 * Single decision point for both failover routes: slim this attempt when the
 * deployment runs in 'always' mode or when an earlier attempt was rejected
 * as upstream-busy (the reactive path).
 */
export function shouldSlimQwenAiAttemptImages(
  mode: QwenAiImageSlimMode,
  afterBusyRejection: boolean,
): boolean {
  return mode === 'always' || (mode === 'on-busy' && afterBusyRejection)
}

const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image'])

function messageImagePartCount(message: ChatMessage): number {
  if (!Array.isArray(message.content)) return 0
  return message.content.filter(part => (
    part && typeof part === 'object' && !Array.isArray(part)
    && IMAGE_PART_TYPES.has(String((part as { type?: unknown }).type || ''))
  )).length
}

function isEnabledFromEnv(): boolean {
  return qwenAiImageSlimModeFromEnv() !== 'off'
}

function keepLastFromEnv(): number {
  // Distinguish unset from empty: Number('') is 0, which would silently turn
  // "keep the last image" into "keep none" when the variable is declared empty.
  const raw = process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES
  if (raw === undefined || raw.trim() === '') return 1
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 1
}

function keepFirstFromEnv(): number {
  const raw = process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES
  if (raw === undefined || raw.trim() === '') return 0
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

// Tell the model how to recover a slimmed image, otherwise it judges visual
// fidelity from memory once its earlier view ages out of the keep window.
const DEFAULT_IMAGE_PLACEHOLDER =
  '[image omitted from replayed history; if you need it, view it again with your image tool]'

function placeholderFromEnv(): string {
  const raw = String(process.env.CHAT2API_QWEN_AI_REPLAY_IMAGE_PLACEHOLDER ?? '').trim()
  return raw || DEFAULT_IMAGE_PLACEHOLDER
}
/**
 * Result of a slimming pass.
 *
 * The counters are the whole reason this returns an object instead of the message
 * array. `charsSlimmed` converts into the same token units the routes already
 * record via `estimateQwenAiRequestInputTokens`, so the image track and the
 * text-compression track can be added without double counting.
 *
 * Counts only. A part count is not identifying; a data URL, a filename or a
 * placeholder body is, and tool output routinely carries all three.
 */
export interface ImageSlimResult {
  messages: ChatMessage[]
  messagesSlimmed: number
  partsSlimmed: number
  charsSlimmed: number
}

function measureImagePartChars(part: unknown): number {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return 0
  const record = part as { type?: unknown; image_url?: unknown; input_image?: unknown }
  if (!IMAGE_PART_TYPES.has(String(record.type || ''))) return 0
  const holder = record.image_url ?? record.input_image
  const url = typeof holder === 'string'
    ? holder
    : typeof (holder as { url?: unknown } | undefined)?.url === 'string'
      ? String((holder as { url: string }).url)
      : ''
  return url.length
}

/**
 * Slim old inline images out of a replayed conversation.
 *
 * The keep set is the FIRST `keepFirst` and the LAST `keepLast` image-bearing
 * messages. The newest one is included unconditionally regardless of
 * configuration, because a placeholder is a downgrade and the newest attachment
 * is the current turn's reference: the model is about to reason about it.
 * `resolveImageSlimPolicy` clamps `keepLast` to 1 for the same reason; this is
 * the second, independent guard, so a caller that constructs keep counts by hand
 * still cannot slim the current turn away.
 *
 * Env reading lives entirely in the policy layer. This function takes every
 * value it needs as an argument, so a caller that passes explicit keep counts is
 * not silently overridden by the environment.
 */
export function slimQwenAiReplayImages(
  messages: readonly ChatMessage[],
  options: { keepLastImageMessages?: number; keepFirstImageMessages?: number; placeholder?: string } = {},
): ImageSlimResult {
  const keepLast = options.keepLastImageMessages ?? keepLastFromEnv()
  const keepFirst = options.keepFirstImageMessages ?? keepFirstFromEnv()
  const placeholder = options.placeholder ?? placeholderFromEnv()
  const imageBearing: number[] = []
  messages.forEach((message, index) => {
    if (messageImagePartCount(message) > 0) imageBearing.push(index)
  })

  // The newest image-bearing message always survives. Without this the keep set
  // could be empty, or could exclude the live turn, and the model would lose
  // access to the image the user just sent.
  const newestImageIndex = imageBearing.length > 0
    ? imageBearing[imageBearing.length - 1]
    : undefined
  const effectiveKeepLast = Math.max(keepLast, newestImageIndex === undefined ? 0 : 1)

  if (imageBearing.length <= keepFirst + effectiveKeepLast) {
    return { messages: [...messages], messagesSlimmed: 0, partsSlimmed: 0, charsSlimmed: 0 }
  }

  const keepSet = new Set([
    ...imageBearing.slice(0, keepFirst),
    ...(newestImageIndex === undefined ? [] : [newestImageIndex]),
    ...imageBearing.slice(imageBearing.length - effectiveKeepLast),
  ])
  const slimSet = new Set(imageBearing.filter(index => !keepSet.has(index)))

  let messagesSlimmed = 0
  let partsSlimmed = 0
  let charsSlimmed = 0

  const rewritten = messages.map((message, index) => {
    if (!slimSet.has(index) || !Array.isArray(message.content)) return message
    let touched = false
    const content = (message.content as Array<Record<string, unknown>>).map(part => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return part
      if (!IMAGE_PART_TYPES.has(String(part.type || ''))) return part
      touched = true
      partsSlimmed += 1
      // Only the dropped payload counts. The text part of the same message
      // survives as the placeholder, so counting the whole message would
      // overstate the saving.
      charsSlimmed += measureImagePartChars(part)
      return { type: 'text', text: placeholder }
    })
    if (!touched) return message
    messagesSlimmed += 1
    return { ...message, content }
  })

  return { messages: rewritten, messagesSlimmed, partsSlimmed, charsSlimmed }
}
