import type { ChatMessage, ChatCompletionTool, ToolCall } from '../types.ts'
import type { QwenAiToolNameAliasTable } from './qwenAiToolNameAlias.ts'

export type ToolCallingMode = 'managed' | 'disabled'
export type ToolProtocolId =
  | 'openai_chat'
  | 'managed_bracket'
  | 'managed_xml'
  | 'qwen_hermes'
  | 'qwen_native'
  | 'anthropic_tool_use'
  | 'codex_responses'
  | 'm365_fenced'

export type ToolSource = 'openai' | 'mcp'

export interface NormalizedToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
  source: ToolSource
}

export interface NormalizedToolCall {
  id: string
  index: number
  name: string
  arguments: string
  protocol: ToolProtocolId
  rawText?: string
}

export interface NormalizedToolResult {
  toolCallId: string
  name?: string
  content: string
  isError?: boolean
}

export interface ToolCallDiagnostics {
  requestId?: string
  clientAdapterId: string
  detectedClientType?: string
  providerId: string
  model?: string
  actualModel?: string
  toolSource: 'openai' | 'mcp' | 'none'
  mode: ToolCallingMode
  protocol: ToolProtocolId
  toolCount: number
  injected: boolean
  reason: string
  parserFormat?: ToolProtocolId | 'unknown'
  parsedToolCallCount?: number
  malformedReason?: string
  invalidToolNames?: string[]
  wrapperLeakDetected?: boolean
  toolChoiceMode?: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  allowedToolNames?: string[]
  workflowContinuation: boolean
  failedToolResultPending: boolean
}

export interface ToolCallingPlan {
  mode: ToolCallingMode
  protocol: ToolProtocolId
  clientAdapterId: string
  providerId: string
  tools: NormalizedToolDefinition[]
  shouldInjectPrompt: boolean
  shouldParseResponse: boolean
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  allowedToolNames: Set<string>
  /**
   * `allowedToolNames` plus the upstream aliases of any renamed tools. Only the
   * upstream native function_call channel validates against this set; the
   * response path, the parser, and anything client-visible use
   * `allowedToolNames`.
   */
  allowedUpstreamToolNames?: Set<string>
  workflowContinuation: boolean
  failedToolResultPending: boolean
  /**
   * The conversation contains at least one matched tool-call/result exchange
   * that was never closed with a completion marker, even when the trailing
   * item is a user message (a "continue" after a stall). A live workflow is
   * not reset by a user turn; answers over it are held to the continuation
   * contract.
   */
  hasLiveToolWorkflow?: boolean
  forcedToolName?: string
  /**
   * Upstream-wire renames for client tools whose names collide with Qwen's
   * platform-native tool registry. `tools` carries the aliased (upstream)
   * names; parsed calls are translated back through this table before they
   * reach the client, so the client contract is unchanged.
   */
  toolNameAliases?: QwenAiToolNameAliasTable
  diagnostics: ToolCallDiagnostics
}

export interface ToolCallingTransformResult {
  messages: ChatMessage[]
  tools?: ChatCompletionTool[]
  plan: ToolCallingPlan
}

export interface ToolParseContext {
  tools: NormalizedToolDefinition[]
  protocol: ToolProtocolId
  allowPartial?: boolean
  /**
   * Upstream alias -> client name. The prompt teaches the model the alias, so a
   * parsed call may carry the alias; resolving it here means the parser emits
   * the client's declared name and the rest of the pipeline stays in client
   * space. Without this the alias is rejected as an undeclared tool name.
   */
  toolNameAliases?: QwenAiToolNameAliasTable
}

export interface ToolParseResult {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  malformedReason?: string
  invalidToolNames: string[]
}
