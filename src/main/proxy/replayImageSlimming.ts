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
  const raw = Number(process.env.CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES)
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 1
}

export function slimQwenAiReplayImages(
  messages: readonly ChatMessage[],
  options: { keepLastImageMessages?: number } = {},
): ChatMessage[] {
  if (!isEnabledFromEnv()) return [...messages]

  const keepLast = options.keepLastImageMessages ?? keepLastFromEnv()
  const imageBearing: number[] = []
  messages.forEach((message, index) => {
    if (messageImagePartCount(message) > 0) imageBearing.push(index)
  })
  if (imageBearing.length <= keepLast) return [...messages]

  const keepFrom = imageBearing.length - keepLast
  const slimSet = new Set(imageBearing.slice(0, keepFrom))

  return messages.map((message, index) => {
    if (!slimSet.has(index) || !Array.isArray(message.content)) return message
    const content = (message.content as Array<Record<string, unknown>>).map(part => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return part
      if (!IMAGE_PART_TYPES.has(String(part.type || ''))) return part
      return { type: 'text', text: '[image omitted from replayed history]' }
    })
    return { ...message, content }
  })
}
