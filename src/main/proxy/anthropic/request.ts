import type { ChatMessage } from '../types.ts'

export interface AnthropicToolResultInput {
  tool_use_id: string
  content: string | ChatMessage['content']
  is_error?: boolean
}

/** Preserve Anthropic's out-of-band execution status at the internal boundary. */
export function anthropicToolResultToChatMessage(
  result: AnthropicToolResultInput,
): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: result.tool_use_id,
    content: result.content,
    ...(typeof result.is_error === 'boolean' ? { is_error: result.is_error } : {}),
  }
}
