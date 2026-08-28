import type { NormalizedToolResult, ToolProtocolId } from './types.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'
import { qwenHermesProtocol } from './protocols/qwenHermes.ts'
import { qwenNativeProtocol } from './protocols/qwenNative.ts'
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

let warnedUnknownQwenAiManagedProtocol = false

/**
 * Managed tool protocol for the qwen-ai provider. Defaults to the
 * stress-verified hermes tags; 'qwen_native' opts into the experimental
 * <function_calls> format, which the Qwen platform may intercept as its own
 * native tool-call wire format (see the qwen-ai profile comment).
 */
export function qwenAiManagedProtocolFromEnv(): 'qwen_hermes' | 'qwen_native' {
  const raw = String(process.env.CHAT2API_QWEN_AI_MANAGED_PROTOCOL ?? '').trim().toLowerCase()
  if (raw === 'qwen_native') return 'qwen_native'
  if (raw && raw !== 'qwen_hermes' && !warnedUnknownQwenAiManagedProtocol) {
    warnedUnknownQwenAiManagedProtocol = true
    console.warn(`[QwenAI] Unknown CHAT2API_QWEN_AI_MANAGED_PROTOCOL=${raw}, using "qwen_hermes"`)
  }
  return 'qwen_hermes'
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




const qwenAiNativeHistoryProfile: Omit<ProviderToolProfile, 'providerId'> = {
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'qwen_native',
  usesTranscriptDocumentTransport: true,
  formatAssistantToolCalls(calls) {
    return qwenNativeProtocol.formatAssistantToolCalls(calls)
  },
  formatToolResult(result) {
    return qwenNativeProtocol.formatToolResult(result)
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
  // 'qwen-ai' resolves per call in getProviderToolProfile so the managed
  // protocol env knob (CHAT2API_QWEN_AI_MANAGED_PROTOCOL) cannot desync the
  // history formatters from the teaching protocol across env changes.
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
  // The qwen-ai protocol knob resolves per call instead of module-load time
  // so history formatters and the teaching protocol can never diverge when
  // the env changes without a process restart.
  if (providerId === 'qwen-ai') {
    return {
      providerId,
      ...(qwenAiManagedProtocolFromEnv() === 'qwen_native'
        ? qwenAiNativeHistoryProfile
        : qwenAiHermesHistoryProfile),
    }
  }
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
  }
}
