/**
 * M365 ChatHub Types
 * Mirrors M365-Copilot2API/internal/chathub/types.go
 */

export interface ChatHubAccount {
  accessToken: string
  oid: string
  tid: string
}

export interface ChatRequest {
  text: string
  tone?: string
  sessionId?: string
  conversationId?: string
  started?: boolean
  attachments?: unknown[]
  tools?: unknown[]
  toolChoice?: unknown
  mcpServerUrl?: string
  customInstructions?: string
  /**
   * True when the CLIENT declared tools for this request, including the
   * managed path where the fenced protocol replaces the wire `tools` array
   * with an empty one. M365 must not be allowed to answer a tool-bearing
   * request from its own code-interpreter sandbox, so the transport uses
   * this (not `tools.length`) to decide which option sets to send.
   */
  callerToolsActive?: boolean
  /**
   * Copilot Studio agent id for this turn. When present the invocation routes
   * through the agent, whose tool contract lives in its SERVER-SIDE system
   * prompt — the only placement this backend actually honours. The agent wire
   * fields REPLACE `plugins`; sending both is not the measured shape.
   */
  studioAgentId?: string
}

export interface ChatResult {
  text: string
  reasoning?: string
  conversationId: string
  sessionId: string
  requestId: string
  throttling?: unknown
  rawResult?: string
  events: StreamEvent[]
}

export interface StreamEvent {
  kind: 'text' | 'reasoning' | 'tool' | 'progress'
  text?: string
  messageType?: string
  contentType?: string
  toolName?: string
  arguments?: unknown
  raw: unknown
}

export type StreamHandler = (event: StreamEvent) => void | Promise<void>
