import type { ProviderModelCapability } from '../../shared/types'

export interface ParsedProviderModels {
  supportedModels: string[]
  modelMappings: Record<string, string>
  modelCapabilities: Record<string, ProviderModelCapability>
}

export type ProviderModelCapabilities = Record<string, ProviderModelCapability>

/**
 * Merge capability metadata without treating a catalogue response that has no
 * capability fields as an instruction to erase values learned previously.
 * Capability objects are copied so callers cannot mutate persisted metadata by
 * retaining a reference to the parser result or built-in configuration.
 */
export function mergeProviderModelCapabilities(
  existing?: ProviderModelCapabilities,
  reported?: ProviderModelCapabilities,
): ProviderModelCapabilities | undefined {
  const merged: ProviderModelCapabilities = {}

  for (const [model, capability] of Object.entries(existing || {})) {
    if (capability && typeof capability === 'object') {
      merged[model] = { ...capability }
    }
  }

  for (const [model, capability] of Object.entries(reported || {})) {
    if (capability && typeof capability === 'object') {
      const matchingKeys = Object.keys(merged).filter(
        (existingModel) => existingModel.toLowerCase() === model.toLowerCase(),
      )
      if (matchingKeys.length === 0) {
        merged[model] = { ...capability }
      } else {
        for (const matchingKey of matchingKeys) {
          merged[matchingKey] = {
            ...merged[matchingKey],
            ...capability,
          }
        }
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

function extractModelsPayload(responseData: unknown): unknown[] {
  if (Array.isArray(responseData)) {
    return responseData
  }

  if (!responseData || typeof responseData !== 'object') {
    return []
  }

  const data = (responseData as { data?: unknown }).data
  if (Array.isArray(data)) {
    return data
  }

  if (data && typeof data === 'object') {
    // MiMo format: data.modelConfigList or data.modelConfigListNg
    const mimoRecord = data as { modelConfigList?: unknown; modelConfigListNg?: unknown }
    if (Array.isArray(mimoRecord.modelConfigList)) {
      return mimoRecord.modelConfigList
    }
    if (Array.isArray(mimoRecord.modelConfigListNg)) {
      return mimoRecord.modelConfigListNg
    }

    const nestedData = (data as { data?: unknown }).data
    if (Array.isArray(nestedData)) {
      return nestedData
    }
  }

  return []
}

export function parseProviderModelsResponse(responseData: unknown): ParsedProviderModels {
  const models = extractModelsPayload(responseData)
  const supportedModels: string[] = []
  const modelMappings: Record<string, string> = {}
  const modelCapabilities: Record<string, ProviderModelCapability> = {}
  const seenModels = new Set<string>()

  for (const model of models) {
    if (typeof model === 'string') {
      if (!seenModels.has(model)) {
        seenModels.add(model)
        supportedModels.push(model)
        modelMappings[model] = model
      }
      continue
    }

    if (!model || typeof model !== 'object') {
      continue
    }

    const candidate = model as {
      [key: string]: unknown
      id?: unknown
      model_id?: unknown
      model?: unknown
      name?: unknown
      display_name?: unknown
      info?: unknown
      meta?: unknown
      think_skip?: unknown
      nToken?: unknown
    }

    // MiMo uses 'model' field for the actual model ID and 'name' for display name
    const modelId = String(candidate.model || candidate.id || candidate.model_id || candidate.name || '')
    const modelName = String(candidate.name || candidate.display_name || modelId)

    if (modelId && !seenModels.has(modelName)) {
      seenModels.add(modelName)
      supportedModels.push(modelName)
      modelMappings[modelName] = modelId

      const thinkingSkippable = readThinkingSkippable(candidate)
      const maxContextLength = readPositiveInteger(candidate, [
        'max_context_length',
        'maxContextLength',
        'context_length',
        'contextLength',
        'nToken',
      ])
      const maxSummaryGenerationLength = readPositiveInteger(candidate, [
        'max_summary_generation_length',
        'maxSummaryGenerationLength',
        'summary_generation_length',
        'summaryGenerationLength',
      ])
      if (
        thinkingSkippable !== undefined
        || maxContextLength !== undefined
        || maxSummaryGenerationLength !== undefined
      ) {
        const capability: ProviderModelCapability = {
          ...(thinkingSkippable !== undefined ? { thinkingSkippable } : {}),
          ...(maxContextLength !== undefined ? { maxContextLength } : {}),
          ...(maxSummaryGenerationLength !== undefined ? { maxSummaryGenerationLength } : {}),
        }
        modelCapabilities[modelName] = capability
        modelCapabilities[modelId] = capability
      }
    }
  }

  return { supportedModels, modelMappings, modelCapabilities }
}

function readPositiveInteger(
  model: { [key: string]: unknown; info?: unknown; meta?: unknown },
  keys: string[],
): number | undefined {
  const values: unknown[] = []
  for (const key of keys) values.push(model[key])
  for (const container of [model.info, model.meta]) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue
    const record = container as Record<string, unknown>
    for (const key of keys) values.push(record[key])
    for (const nestedName of ['capabilities', 'limits', 'context', 'meta', 'model_info']) {
      const nested = record[nestedName]
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
      const nestedRecord = nested as Record<string, unknown>
      for (const key of keys) values.push(nestedRecord[key])
    }
  }
  for (const value of values) {
    // Handle MiMo's nToken format like "1M", "256K"
    if (typeof value === 'string') {
      const trimmed = value.trim().toUpperCase()
      const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([KMGT])?$/)
      if (match) {
        const num = parseFloat(match[1])
        const suffix = match[2]
        const multiplier = suffix === 'K' ? 1024 : suffix === 'M' ? 1024 * 1024 : suffix === 'G' ? 1024 * 1024 * 1024 : suffix === 'T' ? 1024 * 1024 * 1024 * 1024 : 1
        const result = Math.round(num * multiplier)
        if (Number.isSafeInteger(result) && result > 0) return result
      }
      const numeric = Number(trimmed)
      if (Number.isSafeInteger(numeric) && numeric > 0) return numeric
      continue
    }
    const numeric = typeof value === 'number' ? value : NaN
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric
  }
  return undefined
}

function readThinkingSkippable(model: {
  info?: unknown
  meta?: unknown
  think_skip?: unknown
  thinkingDefaultOn?: unknown
}): boolean | undefined {
  const candidates = [
    getNestedValue(model.info, ['meta', 'think_skip', 'enable']),
    getNestedValue(model.meta, ['think_skip', 'enable']),
    getNestedValue(model.think_skip, ['enable']),
  ]
  const found = candidates.find((value): value is boolean => typeof value === 'boolean')
  if (found !== undefined) return found
  // MiMo uses thinkingDefaultOn
  if (typeof model.thinkingDefaultOn === 'boolean') {
    return !model.thinkingDefaultOn
  }
  return undefined
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
