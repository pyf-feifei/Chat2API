export interface QwenAiFeatureConfigOptions {
  thinkingEnabled: boolean
  autoThinking: boolean
  /** Upstream three-state enum mirroring the browser payload; omit to keep legacy shape. */
  thinkingMode?: 'Fast' | 'Auto' | 'Thinking'
  thinkingBudget?: number
}

/** Match qwen.ai's Fast/Thinking feature payload without inventing fields. */
export function createQwenAiFeatureConfig(
  options: QwenAiFeatureConfigOptions,
): Record<string, unknown> {
  const featureConfig: Record<string, unknown> = {
    thinking_enabled: options.thinkingEnabled,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: options.autoThinking,
    auto_search: false,
  }

  // Browser captures pair the enum with the booleans; send it alongside so the
  // upstream sees the exact feature_config the web UI would have produced.
  if (options.thinkingMode) {
    featureConfig.thinking_mode = options.thinkingMode
  }

  if (options.thinkingEnabled) {
    featureConfig.thinking_format = 'summary'
    if (options.thinkingBudget) {
      featureConfig.thinking_budget = options.thinkingBudget
    }
  }

  return featureConfig
}
