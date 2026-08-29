import type { ChatMessage } from './types'

/**
 * Replays of a long tool session re-upload every embedded image with the
 * transcript. A history carrying dozens of screenshots trips the upstream
 * risk page (FAIL_SYS_USER_VALIDATE / "被挤爆啦") on every account — observed
 * 2026-08-29: a 433-message replay with ~40 embedded images was rejected on
 * all six rotated accounts while the same text-only history passed.
 *
 * On a rotation replay after such a rejection, keep only the newest
 * image-bearing message intact and replace older embedded images with a text
 * placeholder. Client-agnostic: works on generic message structure.
 */

const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image'])

function messageImagePartCount(message: ChatMessage): number {
  if (!Array.isArray(message.content)) return 0
  return message.content.filter(part => (
    part && typeof part === 'object' && !Array.isArray(part)
    && IMAGE_PART_TYPES.has(String((part as { type?: unknown }).type || ''))
  )).length
}

function isEnabledFromEnv(): boolean {
  return String(process.env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES ?? '').trim().toLowerCase() !== 'off'
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
