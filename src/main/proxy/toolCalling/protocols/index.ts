import type { ToolProtocolAdapter } from './base.ts'
import type { ToolProtocolId } from '../types.ts'
import { managedBracketProtocol } from './managedBracket.ts'
import { managedXmlProtocol } from './managedXml.ts'
import { qwenHermesProtocol } from './qwenHermes.ts'
import { qwenNativeProtocol } from './qwenNative.ts'
import { anthropicToolUseProtocol } from './anthropicToolUse.ts'
import { codexResponsesProtocol } from './codexResponses.ts'
import { m365FencedProtocol } from './m365Fenced.ts'

const protocols: Record<ToolProtocolId, ToolProtocolAdapter> = {
  openai_chat: managedBracketProtocol,
  managed_bracket: managedBracketProtocol,
  managed_xml: managedXmlProtocol,
  qwen_hermes: qwenHermesProtocol,
  qwen_native: qwenNativeProtocol,
  anthropic_tool_use: anthropicToolUseProtocol,
  codex_responses: codexResponsesProtocol,
  m365_fenced: m365FencedProtocol,
}

export function getToolProtocol(id: ToolProtocolId): ToolProtocolAdapter {
  return protocols[id]
}

export function getManagedProtocols(): ToolProtocolAdapter[] {
  return [
    managedBracketProtocol,
    managedXmlProtocol,
    qwenHermesProtocol,
    qwenNativeProtocol,
    anthropicToolUseProtocol,
    codexResponsesProtocol,
    m365FencedProtocol,
  ]
}
