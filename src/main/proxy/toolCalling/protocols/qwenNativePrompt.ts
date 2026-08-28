import type { NormalizedToolDefinition } from '../types.ts'

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
  return serializeJson({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters ?? {},
    },
  })
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
    '<function_calls>',
    '<invoke name="example_function_name">',
    '<parameter name="example_parameter_name">',
    'parameter_value',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
    '',
    'Use only declared function and parameter names. Include every required parameter and satisfy the selected function JSON schema. Encode object and array parameter values as JSON. Wrap ALL function calls in a single <function_calls> block. You may provide brief reasoning before the first function call, but never add text after a function call. If completing the request requires a tool, emit the tool call NOW in this response - do not describe, promise, or announce what you will do later. If no function is needed, provide your complete final answer and end it with the exact marker <chat2api_workflow_complete/> as the final characters. Never respond with only a plan, progress update, or description of intended actions without either a tool call or the completion marker.',
  ]
  return lines.join('\n')
}

export function renderQwenNativeRecoveryPrompt(tools: NormalizedToolDefinition[]): string {
  const lines = [
    'Return only one or more function calls with no prose before or after them.',
    'Available function names: ' + serializeJson(tools.map((tool) => tool.name)),
    'Exact format:',
    '<function_calls>',
    '<invoke name="exact_function_name">',
    '<parameter name="exact_parameter_name">',
    'parameter_value',
    '</parameter>',
    '</invoke>',
    '</function_calls>',
    'Repeat the invoke block for every required function call. Encode object and array values as JSON.',
  ]
  return lines.join('\n')
}
