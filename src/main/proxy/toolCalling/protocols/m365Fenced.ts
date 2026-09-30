import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import type { ToolCall } from '../../types.ts'

const FENCE = '```'

/**
 * How many fenced calls one M365 turn may yield.
 *
 * This backend does not stop at a call: it writes its whole plan into one
 * reply and then narrates the results of the steps it never ran
 * (cramt/m365-copilot-proxy, "One call per turn" — later steps then run on
 * guessed state, and the invented narration reads as a finished task). One
 * real action per turn is what turns a single reply into a working loop, so
 * the default is 1. `CHAT2API_M365_MAX_TOOL_CALLS_PER_TURN` raises it for
 * clients that need parallel calls on a tenant whose model does stop at the
 * call.
 */
export function m365MaxToolCallsPerTurn(): number {
  const raw = process.env.CHAT2API_M365_MAX_TOOL_CALLS_PER_TURN
  if (raw === undefined || raw.trim() === '') return 1
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) return 1
  return value
}

/**
 * The caller's host platform, stated explicitly.
 *
 * Every framing variant in this prompt teaches POSIX idioms by name
 * (heredocs, `sed -i`, `ls`/`grep`), so on a Windows caller the model emits
 * commands the host cannot run every turn — a fence that never routes reads
 * to the user exactly like "the model ignored my tools"
 * (cramt/m365-copilot-proxy #7). The platform is injectable so the Windows
 * branch stays testable from a POSIX box.
 */
export function m365HostPlatformNote(platform: string = process.platform): string {
  if (platform !== 'win32') return ''
  return "\nThe caller runs Windows. That shell tool is Windows PowerShell 5.1, not bash: Windows paths like D:\\ and \\\\ are directly reachable. Use PowerShell to create a file (Set-Content, Out-File, here-strings), to edit one ((Get-Content -Raw) -replace ... | Set-Content), and to inspect one (Get-ChildItem, Get-Content, Select-String) — never heredocs, `sed -i`, `ls`, `cat` or `grep`, which do not exist there. Do not fall back to a Linux container, a /mnt/data path, or any cloud sandbox, and do not claim the environment changed.\n"
}

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
    // The framing must reference the DECLARED tool name, never a hardcoded
    // 'bash': the parser only accepts fences whose info-string equals a
    // declared tool name, so teaching 'bash' while declaring 'shell' (codex
    // names it shell) trains the model into a fence the parser must reject.
    // `exec_command` is codex 0.154's default shell tool name.
    const shellTool = tools.find((t) =>
      /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system|exec_command)$/i.test(t.name),
    )

    const shellFraming = shellTool
      ? `\nWhen the task involves running commands or inspecting the environment, do the whole step by writing ONE ${FENCE}${shellTool.name} code block. Your FIRST output must be a ${FENCE}${shellTool.name} block - you have run nothing yet, so never claim a command returned no output. You are not the executor: you never see command output unless it arrives in a tool_response block, so never emit any code fence that pretends to show a command's result - the only fence you may write is the next call, after which you stop and wait.\n`
      : ''

    return `## Tool Execution Environment

Performing this task with the tools below is your PRIMARY JOB. Answering the user in prose is, and always will be, SECONDARY: prose is the right output only once the work is actually finished, which you can know only because a <tool_response> for it already appears above.

You are running inside a managed tool-calling harness. The tools listed below are REAL capabilities wired into your runtime by the operator — they are part of your own execution environment, not suggestions, not user-described pretend tools, and not a capability you must disclaim. A fenced block is an ACTION the harness executes for you, never an example, an illustration, or a code sample you are writing for the user. When you emit a fenced call, the harness executes it and returns a <tool_response>. Denying these tools exist or claiming you "cannot access" them is a contract violation.

The tool calls run in the CALLER's environment — the machine/workspace of the program making this request — not in any sandbox you control. Paths, working directories, and available commands belong to that caller's environment; do not assume your own filesystem layout or OS. If a tool result reports a missing file or a different OS/path style, trust the result and adapt to the caller's environment rather than your own.
${m365HostPlatformNote()}
${renderToolList(tools)}
${shellFraming}
## How to call a tool

To use a tool, your ENTIRE reply must be a single Markdown code fence whose info-string is the exact tool name. The FIRST character of your reply must be ${FENCE} — no greeting, no "I will", no "Let me", no explanation, no narration of what you intend to run. Do not describe the command or its expected output; emit the request and stop.

Format:
${FENCE}<tool_name>
<one "key: value" header line per scalar argument>

<the body argument, if the tool has one>
${FENCE}

For tools whose arguments are JSON-like, put a single valid JSON object inside the fence instead of header lines.

Rules:
- Emit exactly ONE fenced tool call per turn, then stop and wait for the tool result. Nothing else in the reply. Keep the rest of your plan to yourself: the state those later steps depend on does not exist yet.
- The info-string and argument keys must match the provided tool definitions exactly.
- Never claim success and never write "Done", "SUCCESS" or a checkmark unless a <tool_response> proving it already appears above — this backend's chat model declares victory before the call has even been sent.
- Never describe a result, never write "the command returned X" — you have not run anything yet. Only a <tool_response> block that already appears above counts as a result.
- Never write a <tool_response> block yourself; only the harness sends those. If you catch yourself predicting one, stop after the fence instead.
- If you write anything that is not the fence itself, the call is invalid and will be rejected.

Tool results will be returned in a block like:

<tool_response name="tool_name" call_id="call_id" call="the arguments that produced this">
result text
</tool_response>

Each result names the tool and the exact call that produced it, so read it as the output of THAT call rather than guessing which step it belongs to. Treat the tool_response block as ground truth and use it to decide the next step; if it reports a failure, fix the cause and call the tool again instead of reporting the failure as the answer. When you have the final answer, respond in natural language with no fence and no preamble or sign-off, ending with the required completion marker. If the request needs no tool at all, answer directly and still end with the marker.`
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
    const maxCalls = m365MaxToolCallsPerTurn()
    // Tool names may carry a namespace separator (e.g. `default_api:read_file`),
    // so the info-string class must accept ':' as well as the plain identifier
    // characters — otherwise namespaced managed tools can never match.
    const regex = /\`\`\`([a-zA-Z0-9_:.\/-]+)\r?\n([\s\S]*?)\`\`\`/g
    let match: RegExpExecArray | null
    let callIndex = 0
    let droppedCalls = 0

    while ((match = regex.exec(content)) !== null) {
      const rawBlock = match[0]
      const toolName = match[1].trim()
      const body = match[2]
      rawMatches.push(rawBlock)

      if (!allowedSet.has(toolName)) {
        invalidToolNames.push(toolName)
        continue
      }

      // The model plans in one breath: fence, then the results of the steps it
      // never ran. Everything past the first real call is either a duplicate
      // or that invented narration, so it is dropped instead of executed on
      // guessed state. The dropped text is not delivered to the client either
      // way — the tail was written before the first call's result existed.
      if (toolCalls.length >= maxCalls) {
        droppedCalls += 1
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

    if (droppedCalls > 0) {
      console.warn('[M365Copilot] dropped batched tool calls beyond the first in one turn', JSON.stringify({
        droppedCalls,
        keptCalls: toolCalls.length,
        maxCalls,
      }))
    }

    const cleanContent = content.replace(/\`\`\`[a-zA-Z0-9_.-]+\r?\n[\s\S]*?\`\`\`/g, '').trim()

    return {
      // Mixed output: this backend narrates a turn it has not finished — a
      // greeting before the fence, a "done!" after it. That prose was written
      // before any result existed, so it is dropped and the client receives
      // the tool call alone (cramt/m365-copilot-proxy, "Mixed output"). The
      // streaming path never reads this field; it releases prose itself.
      content: toolCalls.length > 0 ? '' : cleanContent,
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
    // The model reads an unlabelled result as "whatever step this was" and
    // misattributes it — observed live: it ran a directory listing, saw the
    // target file in it, and concluded the FILE was empty
    // (cramt/m365-copilot-proxy F16). Naming the originating call keeps the
    // output in context. The attribute is omitted when the transcript has no
    // arguments for the call (older histories), never invented.
    const call = summarizeToolCall(result.summary)
    const attributes = call
      ? ` name="${escapeAttribute(result.name || 'tool')}" call_id="${escapeAttribute(result.toolCallId)}" call="${escapeAttribute(call)}"`
      : ` name="${escapeAttribute(result.name || 'tool')}" call_id="${escapeAttribute(result.toolCallId)}"`
    return `<tool_response${attributes}>\n${result.content}\n</tool_response>`
  },
}

/**
 * One-line rendering of the arguments that produced a tool result, collapsed
 * to a single line and bounded so a multi-kilobyte write does not bloat every
 * later turn's transcript.
 */
const TOOL_CALL_SUMMARY_MAX_CHARS = 120

function summarizeToolCall(rawArguments: string | undefined): string {
  if (!rawArguments) return ''
  const collapsed = rawArguments.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > TOOL_CALL_SUMMARY_MAX_CHARS
    ? `${collapsed.slice(0, TOOL_CALL_SUMMARY_MAX_CHARS)}…`
    : collapsed
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
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
