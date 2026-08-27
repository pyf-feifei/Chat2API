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
