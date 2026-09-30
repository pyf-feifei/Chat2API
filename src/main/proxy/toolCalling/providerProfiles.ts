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
  // True when the provider platform exposes its own capabilities (e.g. web
  // search) that can intercept a managed-tool turn instead of the declared
  // client tools, so undeclared-capability exclusion rules apply.
  excludesUndeclaredProviderCapabilities: boolean
  /**
   * True when the platform's chat models routinely keep writing after their
   * own tool call — inventing the tool-result envelope they expect and then
   * acting on that fiction. The invented block is stripped and the real call
   * at the head is kept, instead of failing the request on a wrapper leak
   * that costs a correct call (cramt/m365-copilot-proxy #31).
   */
  stripsInventedToolResultWrappers?: boolean
  /**
   * Opt a protocol that does not require the completion marker into teaching
   * it as an OPTIONAL proof. Lets a short final answer after a tool result be
   * told apart from stall narration without any wording heuristics.
   */
  workflowCompletionMarker?: 'optional'
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}

let warnedUnknownQwenAiManagedProtocol = false

/**
 * Z.ai optional completion marker (default on). Without a proof channel a
 * short correct final answer after a tool result ("README.md has 412 lines")
 * is structurally indistinguishable from stall narration, and the recovery
 * nudge demanded another tool call until the turn failed (observed live
 * 2026-09-29, GLM-5.3-Flash). Set CHAT2API_ZAI_COMPLETION_MARKER=off to
 * restore the marker-less contract.
 */
export function zaiCompletionMarkerFromEnv(): boolean {
  const raw = String(process.env.CHAT2API_ZAI_COMPLETION_MARKER ?? '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw)
}

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
  excludesUndeclaredProviderCapabilities: false,
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
  excludesUndeclaredProviderCapabilities: true,
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
  excludesUndeclaredProviderCapabilities: true,
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
  excludesUndeclaredProviderCapabilities: false,
  stripsInventedToolResultWrappers: true,
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
  // Z.ai uses transcript document offload for long contexts and has its own
  // web search / tool capabilities that can intercept managed-tool turns.
  zai: {
    providerId: 'zai',
    ...chat2ApiXmlHistoryProfile,
    usesTranscriptDocumentTransport: true,
    excludesUndeclaredProviderCapabilities: true,
  },
  // 'qwen-ai' resolves per call in getProviderToolProfile so the managed
  // protocol env knob (CHAT2API_QWEN_AI_MANAGED_PROTOCOL) cannot desync the
  // history formatters from the teaching protocol across env changes.
  // Explicit so protocol choice for the Copilot transport is intentional
  // instead of riding the unknown-provider fallback. No caller-defined tool
  // channel has been VERIFIED on the consumer Chathub: the fenced protocol is
  // what this repo teaches and enforces. Two higher-starred projects
  // (HEXUXIU/M365-Copilot2API, shenping1200/m365-copilot-bridge) do send
  // caller tools as `plugins: [{Id, Source: "API"}]` and read real calls back
  // out of the stream frames — and then skip the prompt injection entirely when
  // plugins are present. That is a DIFFERENT transport, not evidence that the
  // fenced one is wrong; see docs/providers/m365-copilot.md before switching.
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
  if (providerId === 'zai') {
    // Resolved per call so the env switch applies without a rebuild.
    return zaiCompletionMarkerFromEnv()
      ? { ...profiles.zai, workflowCompletionMarker: 'optional' }
      : profiles.zai
  }
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
  }
}
