import type { NormalizedToolResult, ToolProtocolId } from './types.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'
import { qwenHermesProtocol } from './protocols/qwenHermes.ts'
import { m365FencedProtocol } from './protocols/m365Fenced.ts'

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


const m365FencedHistoryProfile: Omit<ProviderToolProfile, 'providerId'> = {
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'm365_fenced',
  usesTranscriptDocumentTransport: false,
  formatAssistantToolCalls(calls) {
    return m365FencedProtocol.formatAssistantToolCalls(calls)
  },
  formatToolResult(result) {
    return m365FencedProtocol.formatToolResult(result)
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
  // Explicit so protocol choice for the Copilot transport is intentional
  // instead of riding the unknown-provider fallback. The consumer Chathub has
  // no native tool channel (verified against winnstorm/m365-copilot-api,
  // cramt/m365-copilot-proxy, edlaver/m365-copilot-bun-proxy), so managed
  // XML prompt injection is the only path here.
  'm365-copilot': {
    providerId: 'm365-copilot',
    ...m365FencedHistoryProfile,
  },
}

export function getProviderToolProfile(providerId: string): ProviderToolProfile {
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
  }
}
