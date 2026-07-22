import type { ToolCallingPlan } from './types.ts'

export type ToolStreamValidationFailure = {
  message: string
  type: 'tool_call_parse_error'
  param: 'tool_calls'
  code: 'malformed_tool_call' | 'missing_tool_call'
}

export function getToolStreamValidationFailure(input: {
  plan?: ToolCallingPlan
  emittedToolCall: boolean
  pendingToolProtocol: boolean
}): ToolStreamValidationFailure | undefined {
  const { plan, emittedToolCall, pendingToolProtocol } = input
  if (!plan?.shouldParseResponse || emittedToolCall) return undefined

  const requiresToolCall = plan.toolChoiceMode === 'required' || plan.toolChoiceMode === 'forced'
  if (!pendingToolProtocol && !requiresToolCall) return undefined

  if (pendingToolProtocol) {
    return {
      message: `Provider returned a malformed or empty tool call block for an ${requiresToolCall ? 'enforced' : 'attempted'} tool call`,
      type: 'tool_call_parse_error',
      param: 'tool_calls',
      code: 'malformed_tool_call',
    }
  }

  return {
    message: 'Provider did not return the required tool call',
    type: 'tool_call_parse_error',
    param: 'tool_calls',
    code: 'missing_tool_call',
  }
}
