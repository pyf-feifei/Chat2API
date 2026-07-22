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
  const modelCapabilities: Record<string, { thinkingSkippable?: boolean }> = {}

  for (const model of models) {
    if (typeof model === 'string') {
      supportedModels.push(model)
      modelMappings[model] = model
      continue
    }

    if (!model || typeof model !== 'object') {
      continue
    }

    const candidate = model as {
      id?: unknown
      model_id?: unknown
      name?: unknown
      display_name?: unknown
      info?: unknown
      meta?: unknown
      think_skip?: unknown
    }
    const modelId = String(candidate.id || candidate.model_id || candidate.name || '')
    const modelName = String(candidate.name || candidate.display_name || modelId)

    if (modelId) {
      supportedModels.push(modelName)
      modelMappings[modelName] = modelId

      const thinkingSkippable = readThinkingSkippable(candidate)
      if (thinkingSkippable !== undefined) {
        const capability = { thinkingSkippable }
        modelCapabilities[modelName] = capability
        modelCapabilities[modelId] = capability
      }
    }
  }

  return { supportedModels, modelMappings, modelCapabilities }
}

function readThinkingSkippable(model: {
  info?: unknown
  meta?: unknown
  think_skip?: unknown
}): boolean | undefined {
  const candidates = [
    getNestedValue(model.info, ['meta', 'think_skip', 'enable']),
    getNestedValue(model.meta, ['think_skip', 'enable']),
    getNestedValue(model.think_skip, ['enable']),
  ]

  return candidates.find((value): value is boolean => typeof value === 'boolean')
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
