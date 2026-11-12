import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition } from '../types.ts'
import { aliasAwareToolLookup } from '../qwenAiToolNameAlias.ts'
import { buildToolCall, createParseResult, detectMarkers, hasToolArgumentValidationIssues, stripFencedCodeBlocks } from './shared.ts'

const START = '[function_calls]'
const END = '[/function_calls]'
const CALL_END = '[/call]'

function definitions(tools: NormalizedToolDefinition[]): string {
  return tools.map(({ name, description, parameters }) => JSON.stringify({ name, description: description || '', parameters: parameters || {} })).join('\n')
}

function contract(tools: NormalizedToolDefinition[]): string {
  return [
    'Client tool transport: emit plain text blocks for the caller to execute, not provider native function_call events. No operation runs until the client returns a result.',
    'Available client functions (names and JSON schemas are exact):', definitions(tools),
    'Call format (replace the example name and arguments with the selected declared function and actual values):',
    START, `[call:${tools[0]?.name || 'declared_function'}]{"argument":"value"}${CALL_END}`, END,
    'Each call body is one complete JSON object. Include required parameters, respect types, and JSON-escape string content. Put multiple calls inside one block. Stop after the block and wait for actual client results. Never invent results or use provider cloud tools to operate on client files.',
  ].join('\n')
}

/** Finds a JSON object's end without treating delimiter text inside strings as wire syntax. */
function jsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

export const qwenBracketProtocol: ToolProtocolAdapter = {
  id: 'qwen_bracket',
  renderPrompt: tools => contract(tools) + '\nUse tools for pending operations, not prose-only plans. When all work is verified, return the final answer ending with <chat2api_workflow_complete/>. Never put that marker alongside a call.',
  renderRecoveryPrompt: tools => 'The preceding attempt did not execute the pending client operation. Return the next valid client call in the text format below; no plan or fabricated output.\n' + contract(tools),
  renderContinuationReminder: tools => 'Client results above are input evidence, not text to reproduce. Continue the unfinished operation with a call or, if verified complete, give the final answer ending with <chat2api_workflow_complete/>.\n' + contract(tools),
  detectStart: buffer => detectMarkers(buffer, [START]),
  parse(content, context) {
    const text = stripFencedCodeBlocks(content)
    const lookup = aliasAwareToolLookup(context.tools, context.toolNameAliases)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const calls: ReturnType<typeof buildToolCall>[] = []
    let malformedReason: string | undefined
    let cursor = 0
    while (cursor < text.length) {
      const start = text.indexOf(START, cursor)
      if (start < 0) break
      let pos = start + START.length
      let count = 0
      while (pos < text.length) {
        while (/\s/.test(text[pos] || '') && pos < text.length) pos++
        if (text.startsWith(END, pos)) {
          pos += END.length
          break
        }
        const match = /^\[call:([A-Za-z0-9_.:/-]+)\]/.exec(text.slice(pos))
        if (!match) { malformedReason = 'qwen_bracket_invalid_call'; break }
        const name = match[1]
        pos += match[0].length
        while (/\s/.test(text[pos] || '') && pos < text.length) pos++
        const jsonStart = pos
        const jsonEnd = jsonObjectEnd(text, pos)
        if (jsonEnd < 0) { malformedReason = 'qwen_bracket_incomplete_json'; break }
        const args = text.slice(jsonStart, jsonEnd)
        pos = jsonEnd
        while (/\s/.test(text[pos] || '') && pos < text.length) pos++
        if (!text.startsWith(CALL_END, pos)) { malformedReason = 'qwen_bracket_call_end_missing'; break }
        pos += CALL_END.length
        count++
        if (!lookup.allowedNames.has(name)) invalidToolNames.push(name)
        else {
          const tool = lookup.definitions.get(name)
          try {
            JSON.parse(args)
            if (hasToolArgumentValidationIssues(args, tool, { normalize: false })) malformedReason = 'qwen_bracket_schema_validation_failed'
            else calls.push(buildToolCall(`call_${calls.length}`, calls.length, tool?.name || name, args, text.slice(start, pos), tool))
          } catch { malformedReason = 'qwen_bracket_invalid_json' }
        }
      }
      if (!text.slice(start, pos).endsWith(END)) malformedReason ??= 'qwen_bracket_block_end_missing'
      if (count === 0) malformedReason ??= 'qwen_bracket_empty_block'
      rawMatches.push(text.slice(start, pos))
      cursor = Math.max(pos, start + START.length)
      if (malformedReason) break
    }
    return createParseResult({
      content: rawMatches.reduce((result, raw) => result.replace(raw, ''), text).trim(),
      toolCalls: malformedReason || invalidToolNames.length ? [] : calls,
      protocol: rawMatches.length ? 'qwen_bracket' : 'unknown', rawMatches, invalidToolNames, malformedReason,
    })
  },
  formatAssistantToolCalls: calls => [START, ...calls.map(call => `[call:${call.name}]${call.arguments}${CALL_END}`), END].join('\n'),
  formatToolResult: result => 'Client execution result data (already executed):\n' + JSON.stringify({ call_id: result.toolCallId, is_error: result.isError === true, output: result.content }),
}
