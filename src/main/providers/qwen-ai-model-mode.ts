/**
 * Client-facing mode aliases for Qwen3.8-Max. These suffixes are never sent
 * upstream: chat.qwen.ai receives the stable qwen3.8-max model id plus the
 * corresponding feature_config flags.
 *
 * The upstream feature_config carries a three-state `thinking_mode` enum
 * ("Fast" | "Auto" | "Thinking", verified against browser captures) next to
 * the legacy booleans. Mode selection precedence:
 *   1. explicit `_Fast` / `_Thinking` suffix pins that mode (client's call);
 *   2. otherwise a client reasoning effort maps onto a mode
 *      (deployment-tunable, see qwenAiEffortModeMapFromEnv);
 *   3. otherwise `_Auto` / bare model name / no effort defaults to Auto.
 */
export type QwenAiThinkingModeName = 'Fast' | 'Auto' | 'Thinking'

export interface QwenAiModelMode {
  baseModel: string
  thinkingEnabled?: boolean
  autoThinking?: boolean
  /** Upstream thinking_mode enum value mirroring the browser payload. */
  thinkingMode?: QwenAiThinkingModeName
  /** True when the client supplied an explicit suffix rather than the default. */
  isExplicit: boolean
  /**
   * 'pinned' — explicit _Fast/_Thinking suffix that overrides any effort;
   * 'floating' — _Auto/bare/unknown, where effort may take over the mode.
   */
  precedence: 'pinned' | 'floating'
}

export interface QwenAiModelCatalogue<TCapability = unknown> {
  supportedModels: string[]
  modelMappings: Record<string, string>
  modelCapabilities?: Record<string, TCapability>
}

export interface QwenAiModelCatalogueWithCapabilities<TCapability>
  extends QwenAiModelCatalogue<TCapability> {
  modelCapabilities: Record<string, TCapability>
}

export const QWEN_AI_38_MAX_MODE_ALIASES = [
  'Qwen3.8-Max_Fast',
  'Qwen3.8-Max_Auto',
  'Qwen3.8-Max_Thinking',
] as const

const QWEN_38_MAX = 'qwen3.8-max'

function isQwen38Max(value: string): boolean {
  return value.toLowerCase() === QWEN_38_MAX
}

function mode(
  baseModel: string,
  thinkingEnabled: boolean,
  autoThinking: boolean,
  thinkingModeName: QwenAiThinkingModeName,
  isExplicit: boolean,
  precedence: 'pinned' | 'floating',
): QwenAiModelMode {
  return {
    baseModel,
    thinkingEnabled,
    autoThinking,
    thinkingMode: thinkingModeName,
    isExplicit,
    precedence,
  }
}

/**
 * Resolve Qwen3.8-Max aliases without changing unrelated model names.
 *
 * `_TeT_AtF` is the raw form: `Te` controls `thinking_enabled` and `At`
 * controls `auto_thinking`. The three named suffixes are convenient aliases.
 */
export function resolveQwenAiModelMode(modelName: string): QwenAiModelMode {
  const model = modelName.trim()

  if (isQwen38Max(model)) {
    // Qwen3.8-Max bare name floats: an explicit client effort may take over
    // the mode; without one it renders as Auto.
    return mode(model, true, true, 'Auto', false, 'floating')
  }

  const shortcut = /^(qwen3\.8-max)_(fast|auto|thinking)$/i.exec(model)
  if (shortcut) {
    const baseModel = shortcut[1]
    switch (shortcut[2].toLowerCase()) {
      case 'fast':
        return mode(baseModel, false, false, 'Fast', true, 'pinned')
      case 'auto':
        return mode(baseModel, true, true, 'Auto', true, 'floating')
      default:
        return mode(baseModel, true, false, 'Thinking', true, 'pinned')
    }
  }

  const rawFlags = /^(qwen3\.8-max)_te([tf])_at([tf])$/i.exec(model)
  if (rawFlags) {
    const thinking = rawFlags[2].toLowerCase() === 't'
    const auto = rawFlags[3].toLowerCase() === 't'
    const thinkingModeName: QwenAiThinkingModeName = !thinking ? 'Fast' : auto ? 'Auto' : 'Thinking'
    return mode(rawFlags[1], thinking, auto, thinkingModeName, true, 'pinned')
  }

  // Continue accepting the previous hyphen aliases for existing clients.
  const legacyShortcut = /^(qwen3\.8-max)-(fast|auto|thinking)$/i.exec(model)
  if (legacyShortcut) {
    const baseModel = legacyShortcut[1]
    switch (legacyShortcut[2].toLowerCase()) {
      case 'fast':
        return mode(baseModel, false, false, 'Fast', true, 'pinned')
      case 'auto':
        return mode(baseModel, true, true, 'Auto', true, 'floating')
      default:
        return mode(baseModel, true, false, 'Thinking', true, 'pinned')
    }
  }

  return { baseModel: model, isExplicit: false, precedence: 'floating' }
}

export function normalizeQwenAiModelModeName(modelName: string): string {
  return resolveQwenAiModelMode(modelName).baseModel
}

/**
 * Deployment-tunable reasoning-effort → thinking-mode mapping.
 * Format: "effort:mode,effort:mode,..." with efforts minimal|low|medium|high|
 * xhigh|default and modes fast|auto|thinking. Unknown or malformed entries
 * fall back to the verified default table rather than failing the request.
 */
const QWEN_AI_EFFORT_MODE_MAP_DEFAULT = 'minimal:fast,low:fast,medium:fast,high:auto,xhigh:thinking,ultracode:thinking,max:thinking,default:auto'

let warnedUnknownEffortModeMap = false

export function qwenAiEffortModeMapFromEnv(): Record<string, QwenAiThinkingModeName> {
  const raw = String(process.env.CHAT2API_QWEN_AI_EFFORT_MODE_MAP ?? '').trim()
  const table: Record<string, QwenAiThinkingModeName> = {}
  let accepted = false
  if (raw) {
    for (const entry of raw.split(',')) {
      const [effort, modeName] = entry.split(':').map(part => part.trim().toLowerCase())
      if (!effort || !modeName) continue
      if (modeName !== 'fast' && modeName !== 'auto' && modeName !== 'thinking') continue
      const normalizedMode = (modeName === 'fast' ? 'Fast' : modeName === 'auto' ? 'Auto' : 'Thinking') as QwenAiThinkingModeName
      table[effort] = normalizedMode
      accepted = true
    }
    if (!accepted && !warnedUnknownEffortModeMap) {
      warnedUnknownEffortModeMap = true
      console.warn(`[QwenAI] Invalid CHAT2API_QWEN_AI_EFFORT_MODE_MAP=${raw}, using default mapping`)
    }
  }
  if (!accepted) {
    for (const entry of QWEN_AI_EFFORT_MODE_MAP_DEFAULT.split(',')) {
      const [effort, modeName] = entry.split(':')
      table[effort] = (modeName === 'fast' ? 'Fast' : modeName === 'auto' ? 'Auto' : 'Thinking') as QwenAiThinkingModeName
    }
  }
  return table
}

/**
 * Apply the effort mapping to a floating model mode. Pinned modes (explicit
 * _Fast/_Thinking suffix) are returned unchanged; a floating mode with no
 * effort keeps its Auto rendering.
 */
export function applyQwenAiEffortToModelMode(
  modelMode: QwenAiModelMode,
  effort: string | undefined | null,
): QwenAiModelMode {
  if (modelMode.precedence === 'pinned') return modelMode
  const normalizedEffort = effort?.trim().toLowerCase()
  if (!normalizedEffort) return modelMode
  const table = qwenAiEffortModeMapFromEnv()
  const mapped = table[normalizedEffort]
  if (!mapped) return modelMode
  if (mapped === modelMode.thinkingMode) return modelMode
  return {
    ...modelMode,
    thinkingEnabled: mapped !== 'Fast',
    autoThinking: mapped === 'Auto',
    thinkingMode: mapped,
  }
}

/**
 * Add the stable, documented shortcuts after a live catalogue refresh.
 * A catalogue that does not contain Qwen3.8-Max is left unchanged.
 */
export function withQwenAiModelModeAliases<TCapability>(
  catalogue: QwenAiModelCatalogueWithCapabilities<TCapability>,
): QwenAiModelCatalogueWithCapabilities<TCapability>
export function withQwenAiModelModeAliases<TCapability>(
  catalogue: QwenAiModelCatalogue<TCapability>,
): QwenAiModelCatalogue<TCapability>
export function withQwenAiModelModeAliases<TCapability>(
  catalogue: QwenAiModelCatalogue<TCapability>,
): QwenAiModelCatalogue<TCapability> {
  const supportedModels = [...catalogue.supportedModels]
  const modelMappings = { ...catalogue.modelMappings }

  const baseMapping = Object.entries(modelMappings).find(([displayName, modelId]) => (
    isQwen38Max(displayName) || isQwen38Max(modelId)
  ))
  if (!baseMapping) {
    return {
      supportedModels,
      modelMappings,
      ...(catalogue.modelCapabilities ? { modelCapabilities: { ...catalogue.modelCapabilities } } : {}),
    }
  }

  const [, baseModelId] = baseMapping
  for (const alias of QWEN_AI_38_MAX_MODE_ALIASES) {
    if (!supportedModels.some(model => model.toLowerCase() === alias.toLowerCase())) {
      supportedModels.push(alias)
    }
    modelMappings[alias] = baseModelId
  }

  return {
    supportedModels,
    modelMappings,
    ...(catalogue.modelCapabilities ? { modelCapabilities: { ...catalogue.modelCapabilities } } : {}),
  }
}

// Keep this export readable for callers that describe the operation as adding
// aliases rather than returning an immutable catalogue copy.
export const addQwenAiModelModeAliases = withQwenAiModelModeAliases
