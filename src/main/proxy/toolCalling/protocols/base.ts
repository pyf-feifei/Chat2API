import type {
  NormalizedToolDefinition,
  NormalizedToolResult,
  ToolParseContext,
  ToolParseResult,
  ToolProtocolId,
} from '../types.ts'

export interface ToolProtocolDetection {
  matched: boolean
  partial: boolean
  markerStart?: number
}

export interface ToolProtocolAdapter {
  id: ToolProtocolId
  renderPrompt(tools: NormalizedToolDefinition[]): string
  /**
   * Render a compact, tool-call-only reminder for an unresolved failed tool
   * result. It is sent as a fresh provider turn, so it must restate the exact
   * protocol without copying tool-result content or request-specific values.
   */
  renderRecoveryPrompt?(tools: NormalizedToolDefinition[]): string
  /**
   * Render a per-turn contract reminder for managed workflow continuation
   * turns (the turn opens with returned tool results). The teaching prompt
   * that carries the syntax and tool declarations lives in the leading
   * system content, which on long provider-side sessions is many turns away
   * from the active delta turn; models then read their own prior plan as
   * "no unfinished operation" and answer with intent prose that silently
   * ends the client loop. This reminder restates the wire format and the
   * declared tool names next to the tool results so the contract is
   * turn-local. Client-agnostic by construction: it renders from the
   * protocol and the declared tools only.
   */
  renderContinuationReminder?(tools: NormalizedToolDefinition[]): string
  detectStart(buffer: string): ToolProtocolDetection
  parse(content: string, context: ToolParseContext): ToolParseResult
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}
