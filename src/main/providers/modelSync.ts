export interface ParsedProviderModels {
  supportedModels: string[]
  modelMappings: Record<string, string>
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
    }
    const modelId = String(candidate.id || candidate.model_id || candidate.name || '')
    const modelName = String(candidate.name || candidate.display_name || modelId)

    if (modelId) {
      supportedModels.push(modelName)
      modelMappings[modelName] = modelId
    }
  }

  return { supportedModels, modelMappings }
}
