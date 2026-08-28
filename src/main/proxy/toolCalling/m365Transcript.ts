/**
 * M365 Copilot managed-tool transcript flattener.
 *
 * The Chathub consumer invocation carries exactly one free-text field
 * (`message.text`) and has no native tool channel (verified against
 * winnstorm/m365-copilot-api, cramt/m365-copilot-proxy and
 * edlaver/m365-copilot-bun-proxy), so the ToolCallingEngine output — injected
 * protocol prompt plus role-labelled history including textualized tool
 * calls/results — is serialized into that single field here.
 */
import { getProviderToolProfile } from './providerProfiles.ts'

export interface ManagedToolTranscriptMessage {
  role: string
  content: unknown
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  is_error?: boolean
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textPart = content.find((p: any) => p?.type === 'text' && typeof p.text === 'string')
    if (textPart && typeof textPart.text === 'string') return textPart.text
  }
  return ''
}

/**
 * Flatten a plain (no-tools) multi-turn conversation into the single
 * `message.text` field. API clients resend the full history on every request;
 * without this the upstream only ever sees the last user message and loses
 * all prior context. Single-turn requests must NOT use this path — the legacy
 * single-message shape stays byte-identical.
 */
export function flattenPlainTranscript(messages: ManagedToolTranscriptMessage[]): string {
  const blocks: string[] = []
  for (const msg of messages) {
    // System content rides options.customInstructions (adapter handles it).
    if (msg.role === 'system') continue
    const text = messageContentToText(msg.content)
    if (!text) continue
    blocks.push(`[${msg.role}]\n${text}`)
  }
  return blocks.join('\n\n')
}

export function flattenManagedTranscript(messages: ManagedToolTranscriptMessage[]): string {
  const toolProfile = getProviderToolProfile('m365-copilot')
  const blocks: string[] = []
  // Map tool_call_id -> tool name from assistant tool_calls so tool results
  // can be labelled with the correct name in the fenced protocol.
  const toolNameById: Record<string, string> = {}
  for (const msg of messages) {
    // System messages are excluded from the text payload and sent via
    // options.customInstructions instead (handled by the adapter).
    if (msg.role === 'system') {
      continue
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          toolNameById[tc.id] = tc.function.name
        }
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === 'system') {
      continue
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const formatted = toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
        id: tc.id ?? '',
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      })))
      blocks.push(`[assistant]\n${formatted}`)
      continue
    }
    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id ?? ''
      const formatted = toolProfile.formatToolResult({
        toolCallId,
        name: toolNameById[toolCallId],
        content: messageContentToText(msg.content),
        isError: msg.is_error === true,
      })
      blocks.push(`[tool]\n${formatted}`)
      continue
    }
    const text = messageContentToText(msg.content)
    if (!text) continue
    blocks.push(`[${msg.role}]\n${text}`)
  }
  return blocks.join('\n\n')
}
