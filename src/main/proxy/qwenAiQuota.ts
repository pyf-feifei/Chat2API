import { normalizeProviderModelForMatch } from './adapters/providerModelOptions.ts'

/** Keys are upstream model IDs, with effort-mode aliases removed. */
export function qwenAiQuotaModelKey(model: string): string {
  return normalizeProviderModelForMatch(String(model || '').trim()).toLowerCase()
}

export function hasQwenAiModelQuota(
  deadlines: Readonly<Record<string, number>> | undefined,
  model: string,
  now: number = Date.now(),
): boolean {
  const key = qwenAiQuotaModelKey(model)
  return Boolean(key && Object.entries(deadlines || {}).some(([candidate, until]) => (
    qwenAiQuotaModelKey(candidate) === key && Number(until) > now
  )))
}
