import type { NormalizedToolResult, ToolProtocolId } from './types.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'
import { qwenHermesProtocol } from './protocols/qwenHermes.ts'

export interface ProviderToolProfile {
  providerId: 'deepseek' | 'kimi' | 'glm' | 'qwen' | string
  managedSupport: boolean
  supportsNativeTools: boolean
  preferredManagedProtocol: ToolProtocolId
  // True when the provider adapter may archive conversation history into an
  // attached transcript document, so transcript-handling rules apply.
  usesTranscriptDocumentTransport: boolean
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}

const chat2ApiXmlHistoryProfile: Omit<ProviderToolProfile, 'providerId'> = {
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'managed_xml',
  usesTranscriptDocumentTransport: false,
  formatAssistantToolCalls(calls) {
    return managedXmlProtocol.formatAssistantToolCalls(calls)
  },
  formatToolResult(result) {
    return managedXmlProtocol.formatToolResult(result)
  },
}

const qwenAiHermesHistoryProfile: Omit<ProviderToolProfile, 'providerId'> = {
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'qwen_hermes',
  usesTranscriptDocumentTransport: true,
  formatAssistantToolCalls(calls) {
    return qwenHermesProtocol.formatAssistantToolCalls(calls)
  },
  formatToolResult(result) {
    return qwenHermesProtocol.formatToolResult(result)
  },
}

const profiles: Record<string, ProviderToolProfile> = {
  deepseek: {
    providerId: 'deepseek',
    ...chat2ApiXmlHistoryProfile,
  },
  kimi: {
    providerId: 'kimi',
    ...chat2ApiXmlHistoryProfile,
  },
  glm: {
    providerId: 'glm',
    ...chat2ApiXmlHistoryProfile,
  },
  qwen: {
    providerId: 'qwen',
    ...chat2ApiXmlHistoryProfile,
  },
  'qwen-ai': {
    providerId: 'qwen-ai',
    ...qwenAiHermesHistoryProfile,
  },
}

export function getProviderToolProfile(providerId: string): ProviderToolProfile {
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
  }
}
