/**
 * Provider-neutral image slimming policy.
 *
 * The transform lives in `replayImageSlimming.ts` and is already
 * provider-neutral: it rewrites `image_url` / `input_image` / `image` content
 * parts into text placeholders without knowing which provider will receive the
 * request. What was missing was the answer to "may this request be slimmed, and
 * how aggressively", which `replayImageSlimming.ts` cannot answer because it
 * knows nothing about providers.
 *
 * This module owns that answer. It deliberately does not own the rewrite, the
 * failover trigger, or the HTTP layer.
 *
 * Design: `docs/superpowers/specs/2026-09-26-provider-neutral-image-slimming-design.md`
 */

import type { Provider, ProviderModelCapability } from '../../shared/types'

/**
 * Whether Chat2API's adapter for a provider actually forwards inline images.
 *
 * Every entry below cites the adapter code that transports the image. A single
 * mention of `image_url` is NOT sufficient evidence: Kimi and MiniMax both
 * reference `image_url` only to choose a focus system message
 * (`kimi.ts:628`, `minimax.ts:514`) and never upload the image, so they are
 * `false` even though a naive grep reports a hit.
 *
 * `false` is the fallback for every unlisted provider, including user-created
 * custom providers. A deployment that knows its custom provider handles images
 * sets `modelCapabilities[model].vision = true` explicitly.
 */
export const VISION_PROVIDER_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  // `qwen-ai.ts` and `qwen-ai-files.ts` build and upload image references
  // through the getstsToken pipeline.
  'qwen-ai': true,
  // `glm.ts:268-284` collects `image_url` parts into image refs before upload.
  glm: true,
  // `zai-files.ts:251-258` decodes `image_url` data URLs; `zai-files.ts:311-315`
  // selects `file` / `image_url` parts for upload.
  zai: true,
  // `mimo-files.ts:192-199` accepts `image_url` / `input_image` / `image` and
  // converts them to `kind: 'image'` media.
  mimo: true,
  // `m365.ts:388-392` maps `image_url` parts onto M365 image attachments.
  'm365-copilot': true,

  // No image transport anywhere in the adapter. The only `image_url` mention is
  // a focus-message heuristic at `kimi.ts:628`.
  kimi: false,
  // Same shape at `minimax.ts:514`.
  minimax: false,
  // No image handling in `qwen.ts`, `deepseek.ts`, or `perplexity.ts`.
  qwen: false,
  deepseek: false,
  perplexity: false,
})

/** Logged once per process when an unlisted provider asks to be slimmed. */
const warnedUnlistedProviders = new Set<string>()

/**
 * Resolve whether a model can consume inline images.
 *
 * Three levels, most specific first:
 *   1. `provider.modelCapabilities[model].vision`
 *   2. the per-adapter default table
 *   3. `false`
 */
export function isVisionProvider(
  provider: Pick<Provider, 'id' | 'modelCapabilities'>,
  actualModel: string,
): boolean {
  const declared = provider.modelCapabilities?.[actualModel] as ProviderModelCapability | undefined
  if (typeof declared?.vision === 'boolean') {
    return declared.vision
  }

  const fallback = VISION_PROVIDER_DEFAULTS[provider.id]
  if (typeof fallback === 'boolean') {
    return fallback
  }

  if (!warnedUnlistedProviders.has(provider.id)) {
    warnedUnlistedProviders.add(provider.id)
    console.warn(
      '[ImageSlim] provider is not in VISION_PROVIDER_DEFAULTS; treating as non-vision. '
        + 'Set provider.modelCapabilities[model].vision = true if this adapter forwards images.',
      JSON.stringify({ providerId: provider.id, model: actualModel }),
    )
  }
  return false
}

/** Reset the once-per-process warning set. Test-only. */
export function resetUnlistedProviderWarnings(): void {
  warnedUnlistedProviders.clear()
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type ImageSlimMode = 'off' | 'on-busy' | 'always'

export interface ImageSlimPolicy {
  enabled: boolean
  keepFirstImageMessages: number
  keepLastImageMessages: number
  placeholder: string
  /** Why this request is being slimmed, for the log line. */
  reason: 'qwen-busy' | 'proactive'
}

export const DEFAULT_IMAGE_SLIM_PLACEHOLDER =
  '[image omitted from replayed history; if you need it, view it again with your image tool]'

const DEFAULT_KEEP_FIRST = 0
const DEFAULT_KEEP_LAST = 1

/**
 * The newest image-bearing message is the current turn's reference image, so
 * `keepLast` is never allowed below 1. A `0` here is a configuration mistake,
 * not a request to discard the image the model is about to reason about.
 */
const MIN_KEEP_LAST = 1

export const QWEN_PROVIDER_ID = 'qwen-ai'

/** Mirrors `qwenAiImageSlimModeFromEnv` in `replayImageSlimming.ts`. */
function parseMode(raw: string | undefined): ImageSlimMode {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'on-busy') return 'on-busy'
  if (value === 'always') return 'always'
  return 'off'
}

/**
 * The mode for a specific provider's variable family.
 *
 * Provider-explicit on purpose. An earlier draft inferred the family from the
 * SHAPE OF THE ENVIRONMENT, which cannot work: a Qwen deployment that sets both
 * families and a fresh deployment that sets neither both need a per-provider
 * answer, and three of the precedence tests failed against the env heuristic.
 * The mode belongs to a provider, not to a process.
 */
export function imageSlimModeFromEnv(
  provider: Pick<Provider, 'id'>,
  env: NodeJS.ProcessEnv = process.env,
): ImageSlimMode {
  if (provider.id === QWEN_PROVIDER_ID) {
    return parseMode(env.CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES)
  }
  // Rule 4: the provider-neutral mode has no Qwen fallback. It defaults to off.
  return parseMode(env.CHAT2API_REPLAY_SLIM_IMAGES)
}

/** Read a non-negative integer variable, treating empty and junk as unset. */
export function parseKeepCount(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function firstDefined(env: NodeJS.ProcessEnv, primary: string, fallback: string): string | undefined {
  return env[primary] !== undefined ? env[primary] : env[fallback]
}

function placeholderFor(env: NodeJS.ProcessEnv): string {
  const raw = firstDefined(env, 'CHAT2API_REPLAY_IMAGE_PLACEHOLDER', 'CHAT2API_QWEN_AI_REPLAY_IMAGE_PLACEHOLDER')
  const value = String(raw ?? '').trim()
  return value || DEFAULT_IMAGE_SLIM_PLACEHOLDER
}

function providerAllowList(env: NodeJS.ProcessEnv): Set<string> | undefined {
  const raw = String(env.CHAT2API_REPLAY_SLIM_PROVIDERS ?? '').trim()
  if (!raw) return undefined
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))
}

function modelAllowList(env: NodeJS.ProcessEnv): Set<string> | undefined {
  const raw = String(env.CHAT2API_REPLAY_SLIM_MODELS ?? '').trim()
  if (!raw) return undefined
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))
}

/**
 * Decide whether a request may be slimmed, and how aggressively.
 *
 * Returns `undefined` for every disqualifier, so a call site cannot ignore the
 * answer by forgetting to check a field.
 *
 * Precedence:
 *   1. Qwen AI reads `CHAT2API_QWEN_AI_REPLAY_*` and nothing else.
 *   2. Other providers read `CHAT2API_REPLAY_*`.
 *   3. An unset provider-neutral keep count or placeholder falls back to its
 *      Qwen-named counterpart, so a tuned deployment carries across providers.
 *   4. The provider-neutral MODE does not fall back. A deployment running Qwen
 *      at `on-busy` must not turn on proactive slimming everywhere else as a
 *      side effect of a new variable existing.
 *
 * `afterBusyRejection` is honored only for Qwen. It is a Qwen STS-quota defense;
 * another provider reporting busy is a different failure and does not imply
 * that re-sending the same images will help.
 */
export function resolveImageSlimPolicy(
  input: {
    provider: Provider
    actualModel: string
    mode: ImageSlimMode
    afterBusyRejection: boolean
  },
  env: NodeJS.ProcessEnv = process.env,
): ImageSlimPolicy | undefined {
  const { provider, actualModel, mode, afterBusyRejection } = input
  if (mode === 'off') return undefined

  const isQwen = provider.id === QWEN_PROVIDER_ID
  const busyTriggered = isQwen && afterBusyRejection
  if (mode === 'on-busy' && !busyTriggered) return undefined

  if (!isVisionProvider(provider, actualModel)) return undefined

  const providers = providerAllowList(env)
  if (providers && !providers.has(provider.id)) return undefined
  const models = modelAllowList(env)
  if (models && !models.has(actualModel)) return undefined

  const keepLastKey = isQwen
    ? 'CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES'
    : 'CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES'
  const keepFirstKey = isQwen
    ? 'CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES'
    : 'CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES'

  const keepLast = isQwen
    ? parseKeepCount(keepLastKey, DEFAULT_KEEP_LAST, env)
    : parseKeepCount(
      keepLastKey,
      parseKeepCount('CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES', DEFAULT_KEEP_LAST, env),
      env,
    )
  const keepFirst = isQwen
    ? parseKeepCount(keepFirstKey, DEFAULT_KEEP_FIRST, env)
    : parseKeepCount(
      keepFirstKey,
      parseKeepCount('CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES', DEFAULT_KEEP_FIRST, env),
      env,
    )

  return {
    enabled: true,
    keepFirstImageMessages: keepFirst,
    keepLastImageMessages: Math.max(keepLast, MIN_KEEP_LAST),
    placeholder: placeholderFor(env),
    reason: busyTriggered ? 'qwen-busy' : 'proactive',
  }
}
