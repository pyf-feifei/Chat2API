import type { NormalizedToolDefinition } from '../types.ts'
import {
  LARGE_PAYLOAD_GUIDANCE_CHUNking,
  LARGE_PAYLOAD_GUIDANCE_RETRY,
  largePayloadGuidanceEnabled,
  getLargePayloadGuidanceWithThreshold,
} from '../promptGuidance.ts'

function largePayloadSuffix(text: string): string {
  return largePayloadGuidanceEnabled() && text ? `
${text}` : ''
}

function largePayloadSuffixWithThreshold(type: 'retry' | 'chunking'): string {
  const guidance = getLargePayloadGuidanceWithThreshold(type)
  return guidance ? `
${guidance}` : ''
}

export type QwenToolPromptFormat = 'native' | 'hermes'

export function qwenToolPromptFormatFromEnv(
  toolProtocolChannel: 'inline' | 'native' | undefined,
): QwenToolPromptFormat {
  const raw = String(process.env.CHAT2API_QWEN_AI_TOOL_PROMPT_FORMAT ?? '').trim().toLowerCase()
  if (raw === 'native') return 'native'
  if (raw === 'hermes') return 'hermes'
  return toolProtocolChannel === 'native' ? 'native' : 'hermes'
}

function escapeJsonBoundaries(content: string): string {
  return content.replace(/<\/?(?:tools|tool_call|tool_response|function_calls|invoke|parameter)>/gi, boundary => (
    boundary.replace('<', '\\u003c').replace('>', '\\u003e')
  ))
}

function serializeJson(value: unknown): string {
  return escapeJsonBoundaries(JSON.stringify(value))
}

function renderToolDefinition(tool: NormalizedToolDefinition): string {
  // Flat managed-contract shape, not the OpenAI {"type":"function"} envelope:
  // that envelope cues the Qwen platform's native function_call channel, which
  // then rejects client-owned tool names with "Tool <name> does not exists.".
  return serializeJson({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters ?? {},
  })
}

const DEFAULT_NATIVE_CALL_EXAMPLE = [
  '<function_calls>',
  '<invoke name="function_name">',
  '<parameter name="parameter_name">',
  'parameter_value',
  '</parameter>',
  '</invoke>',
  '</function_calls>',
].join('\n')

/**
 * The prompt's call-format example must name a tool the request actually
 * declares. A generic `example_function_name` placeholder gets reproduced
 * verbatim under a forced call (live 2026-09-20, qwen3.8-max), and the platform
 * then rejects it as an undeclared native tool call (422). A concrete example
 * built from the first declared tool is always a legal call.
 */
function renderConcreteNativeCallExample(tools: NormalizedToolDefinition[]): string {
  const tool = tools[0]
  if (!tool?.name) return DEFAULT_NATIVE_CALL_EXAMPLE

  const parameterName = firstDeclaredParameterName(tool) ?? 'parameter_name'
  return [
    '<function_calls>',
    `<invoke name="${tool.name}">`,
    `<parameter name="${parameterName}">`,
    'value',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n')
}

function firstDeclaredParameterName(tool: NormalizedToolDefinition): string | undefined {
  const schema = tool.parameters as { required?: unknown; properties?: unknown } | undefined
  if (!schema || typeof schema !== 'object') return undefined
  if (Array.isArray(schema.required)) {
    const firstRequired = schema.required.find((name): name is string => typeof name === 'string' && name.length > 0)
    if (firstRequired) return firstRequired
  }
  const properties = schema.properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return Object.keys(properties as Record<string, unknown>)[0]
  }
  return undefined
}

export function renderQwenNativeFunctionCallsPrompt(tools: NormalizedToolDefinition[]): string {
  const definitions = tools.map(renderToolDefinition).join('\n')
  const lines = [
    '# IMPORTANT: Workflow Completion Marker',
    '',
    'When you complete ALL requested operations, you MUST append this exact marker at the very end of your final answer:',
    '<chat2api_workflow_complete/>',
    '',
    'This marker is required for protocol validation. Answers without it will be rejected and trigger a retry.',
    'Do NOT include this marker in progress updates or alongside tool calls.',
    '',
    '# Tools',
    '',
    'You may call one or more functions to assist with the user query.',
    '',
    'You are provided with function signatures within <tools></tools> XML tags:',
    '<tools>',
    definitions,
    '</tools>',
    '',
    'If you choose to call a function, you MUST use this exact format:',
    renderConcreteNativeCallExample(tools),
    '',
    'Use only declared function and parameter names. Include every required parameter and satisfy the selected function JSON schema. Encode object and array parameter values as JSON. Wrap ALL function calls in a single <function_calls> block. You may provide brief reasoning before the first function call, but never add text after a function call. If completing the request requires a tool, emit the tool call NOW in this response - do not describe, promise, or announce what you will do later. If no function is needed, provide your complete final answer and end it with the exact marker <chat2api_workflow_complete/> as the final characters. Never respond with only a plan, progress update, or description of intended actions without either a tool call or the completion marker.',
    'Calls must be expressed ONLY as the text <function_calls> block shown above. Never emit a tool call through the platform native/structured function_call channel or any other built-in tool mechanism - that channel uses a different tool registry that does not contain these declared tools, so the platform rejects the call with "Tool <name> does not exists." and the operation does not run. The text <function_calls> block is the only call format the client can execute.',
    ...(largePayloadSuffixWithThreshold('chunking') ? [largePayloadSuffixWithThreshold('chunking')] : []),
    'Tool results are input only: the client delivers them to you in fenced result blocks. Never write, repeat, or imitate a tool-result block, a fenced result envelope, or any result-wrapper tag in your own output; your output is only reasoning, a function_calls block, or a final answer.',
  ]
  return lines.join('\n')
}

export function renderQwenNativeRecoveryPrompt(tools: NormalizedToolDefinition[]): string {
  const lines = [
    'Return only one or more function calls with no prose before or after them.',
    'Available function names: ' + serializeJson(tools.map((tool) => tool.name)),
    'Exact format:',
    renderConcreteNativeCallExample(tools),
    'Repeat the invoke block for every required function call. Encode object and array values as JSON.',
    ...(largePayloadSuffixWithThreshold('retry') ? [largePayloadSuffixWithThreshold('retry')] : []),
    'Tool results are input only: the client delivers them to you in fenced result blocks. Never write, repeat, or imitate any tool-result block, fenced result envelope, or result-wrapper tag in your own output — this output must be function calls only.',
  ]
  return lines.join('\n')
}

export function renderQwenNativeContinuationReminder(tools: NormalizedToolDefinition[]): string {
  const lines = [
    'Managed tool workflow status: IN PROGRESS. The tool results above were just returned to you by the client, so the workflow has NOT reached a final answer yet.',
    'This turn must end with exactly one of: (1) the next <function_calls> block for a distinct unfinished operation, or (2) your complete final answer ending with the exact marker <chat2api_workflow_complete/> as the final characters.',
    'The two endings are mutually exclusive: a response containing a <function_calls> block must NOT also contain the completion marker, and the marker must never appear anywhere except as the final characters of a final answer with no tool call.',
    'Do not answer with a plan, progress update, or a description of what you will do next — those are protocol violations on this turn and trigger a retry.',
    'Tool results are input only: never write, repeat, or imitate any tool-result block, fenced result envelope, or result-wrapper tag in your own output — this turn ends with the next function_calls block or the final answer, nothing else.',
    'Declared function names (use only these): ' + serializeJson(tools.map((tool) => tool.name)),
    ...(largePayloadSuffixWithThreshold('chunking') ? [largePayloadSuffixWithThreshold('chunking')] : []),
    'Exact call format:',
    renderConcreteNativeCallExample(tools),
  ]
  return lines.join('\n')
}
