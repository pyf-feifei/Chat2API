/**
 * Proxy Service Module - Type Definitions
 * Defines core data structures for proxy service
 */

import type {
  QwenAiSessionBridge,
  QwenAiSessionState,
} from './qwenAiSessionBridge'

/**
 * OpenAI Message Format
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatMessageContent[] | null
  name?: string
  tool_call_id?: string
  /** Anthropic tool_result failure state preserved by protocol bridges. */
  is_error?: boolean
  tool_calls?: ChatCompletionMessageToolCall[]
}

/**
 * Tool Call in Message
 */
export interface ChatCompletionMessageToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Tool Definition for Function Calling (OpenAI compatible)
 */
export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, any>
    strict?: boolean
  }
}

/**
 * Tool Choice Strategy
 */
export type ChatCompletionToolChoice = 'none' | 'auto' | 'required' | {
  type: 'function'
  function: { name: string }
}

/**
 * Message Content (supports multimodal)
 */
export interface ChatMessageContent {
  type: 'text' | 'image_url' | 'file' | 'input_audio' | 'video_url'
  text?: string
  image_url?: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
  file_url?: {
    url: string
  }
  input_audio?: {
    data: string
    format?: string
  }
  video_url?: {
    url: string
  }
  filename?: string
  mime_type?: string
  local_path?: string
}

/**
 * Chat Completions Request
 */
export interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like web search, thinking mode) */
  originalModel?: string
  /** Internal routing hint used by Gemini-compatible direct upload flows. */
  preferredProviderId?: string
  /** Internal routing hint used by Gemini-compatible direct upload flows. */
  preferredAccountId?: string
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  max_tokens?: number
  presence_penalty?: number
  frequency_penalty?: number
  logit_bias?: Record<string, number>
  user?: string
  /** Abort the upstream request when the client disconnects. */
  signal?: AbortSignal
  /** Provider conversation ID used by web-backed adapters such as Kimi. */
  conversationId?: string
  /** Snake-case alias for provider conversation ID. */
  conversation_id?: string
  /** Direct Kimi chat identifier alias. */
  chatId?: string
  /** Snake-case direct Kimi chat identifier alias. */
  chat_id?: string
  /** Optional Kimi project identifier. */
  projectId?: string
  /** Snake-case Kimi project identifier alias. */
  project_id?: string
  /** Provider parent message ID for multi-turn continuation. */
  parentMessageId?: string
  /** Snake-case alias for provider parent message ID. */
  parent_message_id?: string
  /** Direct Kimi parent message identifier alias. */
  parentId?: string
  /** Snake-case direct Kimi parent message identifier alias. */
  parent_id?: string
  /** Enable web search (OpenAI compatible) */
  web_search?: boolean
  /** Web search options (OpenAI compatible) */
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high'
    user_location?: {
      type: 'approximate'
      approximate?: {
        country?: string
        city?: string
        region?: string
      }
    }
  }
  /** Reasoning effort level (OpenAI compatible) - enables thinking mode */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Reasoning effort level (camelCase, for AI SDK compatibility) */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Explicit provider thinking-mode override. */
  enable_thinking?: boolean
  /** Optional provider thinking budget. */
  thinking_budget?: number
  /** Enable deep research mode (GLM specific) */
  deep_research?: boolean
  /** Tools for function calling */
  tools?: ChatCompletionTool[]
  /** Tool choice strategy */
  tool_choice?: ChatCompletionToolChoice
  /** Tool format - determines response format for tool calls */
  tool_format?: 'native' | 'json' | 'auto'
  /** Allow compatible providers to emit more than one tool call. */
  parallel_tool_calls?: boolean
  /** Structured-output configuration translated from Responses text.format. */
  response_format?: Record<string, any>
  /** Optional client metadata preserved at the protocol boundary. */
  metadata?: Record<string, unknown> | null
  /** Internal image-generation hint translated from a Responses built-in tool. */
  image_generation?: {
    enabled: true
    size?: string
    model?: string
    quality?: string
    format?: string
    action?: 'auto' | 'generate' | 'edit'
  }
}

/**
 * Tool Definition for Function Calling
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters?: {
      type: 'object'
      properties: Record<string, {
        type: string
        description?: string
        enum?: string[]
      }>
      required?: string[]
    }
  }
}

/**
 * Chat Completions Response
 */
export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion' | 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Chat Completions Choice
 */
export interface ChatCompletionChoice {
  index: number
  message?: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  delta?: {
    role?: 'assistant'
    content?: string
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null
}

/**
 * Tool Call in Response
 */
export interface ToolCall {
  index?: number
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Model Information
 */
export interface ModelInfo {
  id: string
  object: 'model'
  created: number
  owned_by: string
  permission?: ModelPermission[]
  root?: string
  parent?: string
}

/**
 * Model Permission
 */
export interface ModelPermission {
  id: string
  object: 'model_permission'
  created: number
  allow_create_engine: boolean
  allow_sampling: boolean
  allow_logprobs: boolean
  allow_search_indices: boolean
  allow_view: boolean
  allow_fine_tuning: boolean
  organization: string
  group: string
  is_blocking: boolean
}

/**
 * Models List Response
 */
export interface ModelsResponse {
  object: 'list'
  data: ModelInfo[]
}

/**
 * Proxy Request Context
 */
export interface QwenAiLogicalRecoveryState {
  /** Request-wide response-id resume attempts consumed across account branches. */
  resumeAttempts: number
  /** Request-wide managed workflow continuation turns consumed. */
  workflowContinuationAttempts: number
  /** Request-wide same-account fresh-chat replays consumed. */
  freshChatRestartAttempts: number
  /** Remaining no-progress recovery budget, initialized by the first recovery. */
  recoveryBudgetRemainingMs?: number
  /** Absolute workflow recovery deadline shared by account branches. */
  workflowRecoveryDeadlineAt?: number
  /** Whether that deadline is the outer request deadline. */
  workflowRecoveryBoundedByRequestDeadline?: boolean
  /** Private semantic branch replay attempts consumed across accounts. */
  accountNeutralReplayAttempts: number
  /** Replacement branches spent on leaked managed tool-result wrappers. */
  wrapperLeakRecoveryAttempts: number
  /** Fresh-chat escalations after the same-chat semantic continuation budget was exhausted. */
  semanticFreshChatEscalations: number
}

/**
 * Request-wide egress-IP recovery ledger for Qwen AI.
 *
 * The Webshare egress switch and its one-shot direct-retry companion outlive a
 * single account attempt: an aliyun verdict (FAIL_SYS_USER_VALIDATE / RGV587 /
 * `bxpunish`) is an exit-IP flag, so the exit must stay switched for every
 * later account on the SAME client request. Keeping this on the context — not
 * in per-attempt locals — is what makes the switch survive the account
 * failover boundary (observed 2026-09-20: the flag was set inside
 * forwardChatCompletion, which the failover loop re-enters per account, so a
 * fresh `false` discarded the switch before the retry reached the adapter).
 */
export interface QwenAiEgressRecoveryState {
  /** Proxy-routed recovery attempts consumed for this client request. */
  webshareRetries: number
  /** Force every remaining attempt of this request through the Webshare proxy. */
  useWebshareProxy: boolean
  /** One-shot direct-exit retry granted after a proxy transport failure. */
  directRetryAfterProxyFailureUsed?: boolean
  /**
   * A Webshare-routed attempt hit HTTP 402 bandwidth exhaustion (pool key
   * drained) — not a content verdict. The exit never tested the verdict, so
   * one extra proxy recovery may still switch to a healthy key.
   */
  webshareBandwidthExhausted?: boolean
  /**
   * A Webshare-routed attempt itself received the bxpunish/RGV587 verdict.
   * Set only when the multi-exit budget is spent — not on the first proxy
   * miss, so later healthy exits can still retest the same payload.
   */
  webshareVerdictSeen?: boolean
  /** Distinct proxy-routed draws that returned the content verdict. */
  webshareVerdictExits?: number
  /** A risk verdict was observed before a proxy bandwidth failure. */
  riskVerdictObserved?: boolean
  /** A terminal risk verdict already closed this logical request. */
  riskVerdictSeen?: boolean
}

export interface ProxyContext {
  requestId: string
  providerId?: string
  accountId?: string
  model: string
  actualModel?: string
  startTime: number
  isStream: boolean
  clientIP?: string
  signal?: AbortSignal
  /** Internal request intent detected before provider forwarding. */
  requestIntent?: 'normal' | 'context_compaction'
  /** Mutable recovery budget shared by all Qwen account attempts in this request. */
  qwenAiLogicalRecoveryState?: QwenAiLogicalRecoveryState
  /** Mutable egress-IP recovery ledger shared by all Qwen account attempts. */
  qwenAiEgressRecoveryState?: QwenAiEgressRecoveryState
  /**
   * The HTTP route already owns a keep-alive stream, so a managed Qwen branch
   * can remain private until terminal validation and account failover finish.
   */
  deferManagedStreamCommit?: boolean
  /**
   * Responses API state that lets Qwen continue a completed managed-tool
   * exchange without replaying the whole client transcript.
   */
  qwenAiSessionBridge?: QwenAiSessionBridge
  /** Stable Responses chain key used to circuit-break reconnecting Codex turns. */
  qwenAiRiskKey?: string
}

/**
 * Request Forward Result
 */
export interface ForwardResult {
  success: boolean
  status?: number
  headers?: Record<string, string>
  body?: any
  stream?: NodeJS.ReadableStream
  skipTransform?: boolean
  error?: string
  latency?: number
  /** Set false when retrying would duplicate a slow or cancelled upstream request. */
  retryable?: boolean
  /** Stable upstream classification used by provider-specific circuit breakers. */
  errorCode?: string
  /** False when a protocol-level response failure should not penalize the selected account. */
  accountFault?: boolean
  /** Retry only by selecting another account before any generation request was accepted upstream. */
  retryScope?: 'next-account'
  /** Internal hint for a narrowly scoped retry that may bypass one account interval. */
  recoveryHint?: 'managed_tool_stream_validation'
  /**
   * Qwen continuation hit a chat whose pinned in-flight response produced no
   * bytes and no terminal event — a stale busy flag. Signal the sticky-chain
   * layer to drop the binding so the next request starts a fresh chat instead
   * of re-attaching to a permanently dead branch.
   */
  deadInFlight?: boolean
  providerSessionId?: string
  parentMessageId?: string
  /** Account that produced the client-visible result after internal routing. */
  effectiveAccountId?: string
  /** Provider that produced the client-visible result after internal routing. */
  effectiveProviderId?: string
  /** Actual provider model used for the client-visible result. */
  effectiveActualModel?: string
  /** Live Qwen chat/parent state to persist after the response completes. */
  qwenAiSessionState?: QwenAiSessionState
  /** Client-visible tool call IDs emitted by a completed Qwen managed turn. */
  qwenAiToolCallIds?: string[]
}

/**
 * Account Selection Result
 */
export interface AccountSelection {
  account: import('../store/types').Account
  provider: import('../store/types').Provider
  actualModel: string
}

/**
 * SSE Event
 */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * Proxy Statistics
 */
export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

/**
 * Proxy Configuration
 */
export interface ProxyConfig {
  port: number
  host: string
  timeout: number
  retryCount: number
  retryDelay: number
  maxConnections: number
  enableCors: boolean
  corsOrigin: string | string[]
}
