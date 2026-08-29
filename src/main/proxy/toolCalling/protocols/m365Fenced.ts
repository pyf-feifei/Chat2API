import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import type { ToolCall } from '../../types.ts'

const FENCE = '```'

function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const params = tool.parameters && typeof tool.parameters === 'object'
        ? JSON.stringify(tool.parameters)
        : '{}'
      return `- ${tool.name}: ${tool.description || ''}\n  parameters: ${params}`
    })
    .join('\n')
}

export const m365FencedProtocol: ToolProtocolAdapter = {
  id: 'm365_fenced',

  renderPrompt(tools) {
    const hasShellTool = tools.some((t) =>
      /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i.test(t.name),
    )

    const shellFraming = hasShellTool
      ? `\nWhen the task involves running commands or inspecting the environment, do the whole step by writing ONE ${FENCE}bash code block. Your FIRST output must be a ${FENCE}bash block - you have run nothing yet, so never claim a command returned no output.\n`
      : ''

    return `## Available Tools

You can call external tools through a structured text format that another program reads and executes on your behalf.

The following tools are available. Tool names are case-sensitive. Use only the exact tool names listed below.

${renderToolList(tools)}
${shellFraming}
## How to call a tool

To use a tool, output ONLY a single Markdown code fence whose info-string is the exact tool name - nothing before or after. The fenced block requests an action to run; it is never an example or illustration.

Format:
${FENCE}<tool_name>
<one "key: value" header line per scalar argument>

<the body argument, if the tool has one>
${FENCE}

For tools whose arguments are JSON-like, put a single valid JSON object inside the fence instead of header lines.

Rules:
- Emit exactly ONE fenced tool call per turn, then stop and wait for the tool result.
- The info-string and argument keys must match the provided tool definitions exactly.
- Never claim success unless a tool result proving it already appears above.
- Do not wrap the fence in any other markup. No prose before or after the fence.

Tool results will be returned in a block like:

<tool_response name="tool_name" call_id="call_id">
result text
</tool_response>

Treat the tool_response block as ground truth and use it to decide the next step. When you have the final answer, respond in natural language with no fence.`
  },

  renderRecoveryPrompt(tools) {
    const names = tools.map((t) => t.name).join(', ')
    return `Your previous response did not contain a valid tool call. Emit exactly one Markdown code fence now. The fence info-string must be one of: ${names}. Put the arguments as "key: value" lines or a single JSON object inside the fence. Output nothing else.`
  },

  detectStart(buffer) {
    const fenceIndex = buffer.indexOf(FENCE)
    if (fenceIndex === -1) {
      for (let len = Math.min(buffer.length, FENCE.length - 1); len > 0; len--) {
        if (buffer.endsWith(FENCE.slice(0, len))) {
          return { matched: false, partial: true, markerStart: buffer.length - len }
        }
      }
      return { matched: false, partial: false }
    }
    const afterFence = buffer.slice(fenceIndex + FENCE.length)
    const newlineIndex = afterFence.indexOf('\n')
    if (newlineIndex === -1) {
      return { matched: false, partial: true, markerStart: fenceIndex }
    }
    return { matched: true, partial: false, markerStart: fenceIndex }
  },

  parse(content, context) {
    const toolCalls: ToolCall[] = []
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const allowedSet = new Set(context.tools.map((t) => t.name))
    const regex = /\`\`\`([a-zA-Z0-9_.-]+)\r?\n([\s\S]*?)\`\`\`/g
    let match: RegExpExecArray | null
    let callIndex = 0

    while ((match = regex.exec(content)) !== null) {
      const rawBlock = match[0]
      const toolName = match[1].trim()
      const body = match[2]
      rawMatches.push(rawBlock)

      if (!allowedSet.has(toolName)) {
        invalidToolNames.push(toolName)
        continue
      }

      const args = parseFenceArguments(body, context.tools.find((t) => t.name === toolName))
      toolCalls.push({
        id: `call_fenced_${callIndex}`,
        index: callIndex,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
        rawText: rawBlock,
      } as ToolCall)
      callIndex++
    }

    const cleanContent = content.replace(/\`\`\`[a-zA-Z0-9_.-]+\r?\n[\s\S]*?\`\`\`/g, '').trim()

    return {
      content: cleanContent,
      toolCalls,
      protocol: 'm365_fenced',
      rawMatches,
      invalidToolNames,
    }
  },

  formatAssistantToolCalls(calls) {
    return calls
      .map((call) => {
        let body: string
        try {
          const parsed = JSON.parse(call.arguments || '{}')
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const entries = Object.entries(parsed)
            if (entries.length === 1 && typeof entries[0][1] === 'string' && /^(command|cmd|script)$/i.test(entries[0][0])) {
              body = entries[0][1] as string
            } else {
              body = entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
            }
          } else {
            body = call.arguments
          }
        } catch {
          body = call.arguments
        }
        return `${FENCE}${call.name}\n${body}\n${FENCE}`
      })
      .join('\n\n')
  },

  formatToolResult(result) {
    return `<tool_response name="${result.name || 'tool'}" call_id="${result.toolCallId}">\n${result.content}\n</tool_response>`
  },
}

function parseFenceArguments(body: string, tool?: NormalizedToolDefinition): Record<string, unknown> {
  const trimmed = body.trim()

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fall through to key: value parsing
    }
  }

  const lines = trimmed.split('\n')
  const args: Record<string, unknown> = {}
  const bodyLines: string[] = []
  let seenBlank = false
  let hasHeader = false

  for (const line of lines) {
    if (!seenBlank && line.trim() === '') {
      seenBlank = true
      continue
    }
    if (!seenBlank) {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
      if (kv) {
        hasHeader = true
        args[kv[1]] = coerceValue(kv[2])
        continue
      }
    }
    bodyLines.push(line)
  }

  if (hasHeader && bodyLines.length > 0) {
    const bodyParam = findBodyParam(tool, Object.keys(args))
    args[bodyParam] = bodyLines.join('\n')
  } else if (!hasHeader && trimmed.length > 0) {
    const bodyParam = findBodyParam(tool, [])
    args[bodyParam] = trimmed
  }

  return args
}

function findBodyParam(tool: NormalizedToolDefinition | undefined, usedKeys: string[]): string {
  const candidates = ['command', 'content', 'code', 'body', 'script', 'text', 'query', 'input', 'patch', 'cmd', 'data', 'contents']
  const properties = getSchemaProperties(tool)
  for (const c of candidates) {
    if (properties.has(c) && !usedKeys.includes(c)) return c
  }
  for (const key of properties) {
    if (!usedKeys.includes(key)) return key
  }
  return 'input'
}

function getSchemaProperties(tool?: NormalizedToolDefinition): Set<string> {
  const parameters = tool?.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return new Set()
  const properties = (parameters as Record<string, unknown>).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return new Set()
  return new Set(Object.keys(properties))
}

function coerceValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  return trimmed
}
