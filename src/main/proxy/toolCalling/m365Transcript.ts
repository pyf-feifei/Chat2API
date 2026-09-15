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
import { MANAGED_WORKFLOW_COMPLETE_MARKER } from './workflowCompletion.ts'

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
  // System content (the injected tool-protocol prompt and any client system
  // rules) must ride the text channel: the consumer wire's
  // options.customInstructions was never observed to reach the model, so the
  // protocol contract lives here as leading [system] blocks.
  const systemBlocks: string[] = []
  // Map tool_call_id -> tool name from assistant tool_calls so tool results
  // can be labelled with the correct name in the fenced protocol.
  const toolNameById: Record<string, string> = {}
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = messageContentToText(msg.content)
      if (text) systemBlocks.push(text)
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
  // Role labels on system blocks are deliberately omitted: the consumer
  // Copilot safety layer blocks messages that open with a forged [system]
  // tag (empirically bisected 2026-08-28). The bare prompt text passes.
  const ordered = systemBlocks.length > 0
    ? [...systemBlocks, ...blocks]
    : blocks
  return ordered.join('\n\n')
}

/**
 * Turn-local contract restatement appended AFTER the user turn in the
 * flattened transcript. The teaching contract sits at the very start of the
 * blob while the active request sits at the end, and the consumer model was
 * observed live (2026-09-13, gpt-5.6-luna) misreading the contract as
 * "tools the USER described" instead of its own environment — then answering
 * with capability-denial prose. Restating the declared tool names next to the
 * active request re-anchors the contract at maximum recency, mirroring the
 * continuation-reminder concept the qwen/zai engines use mid-workflow. Tool
 * names derive from the client request; nothing is hardcoded.
 */
export function renderManagedTailRestatement(tools: Array<{ name?: string }>): string {
  const names = tools.map((t) => t?.name).filter((n): n is string => Boolean(n))
  if (names.length === 0) return ''
  return [
    'Tool contract reminder: the tools available in this conversation are exactly these - '
      + names.join(', ')
      + ' - and no others.',
    'To use one, emit a single ```tool_name code fence with its arguments and stop; never simulate, describe, or fabricate tool output.',
    'When the work is done, give the final answer in natural language ending with ' + MANAGED_WORKFLOW_COMPLETE_MARKER + '.',
  ].join(' ')
}

/**
 * Append a continuation round to the flattened transcript for fresh-conversation
 * replay: the non-compliant assistant turn, then the structured nudge as the
 * next user turn. Role labels come from the same `[role]` format the
 * flattener uses above — the transcript shape is owned here, not by callers.
 */
export function appendManagedReplayTurns(
  baseText: string,
  assistantText: string,
  nudgeText: string,
): string {
  const trimmed = assistantText.trim()
  if (!trimmed) return baseText
  return [
    baseText,
    `[assistant]\n${trimmed}`,
    `[user]\n${nudgeText}`,
  ].join('\n\n')
}
