import assert from 'node:assert/strict'
import test from 'node:test'

import { getToolStreamValidationFailure } from '../../src/main/proxy/toolCalling/streamValidationPolicy.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function plan(toolChoiceMode: ToolCallingPlan['toolChoiceMode']): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen-ai',
    tools: [{ name: 'workspace:read_file', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode,
    allowedToolNames: new Set(['workspace:read_file']),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen-ai',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

test('optional tool calls tolerate a pending managed protocol block', () => {
  assert.equal(
    getToolStreamValidationFailure({
      plan: plan('auto'),
      emittedToolCall: false,
      pendingToolProtocol: true,
    }),
    undefined,
  )
})

test('required and forced tool calls reject a pending managed protocol block', () => {
  for (const toolChoiceMode of ['required', 'forced'] as const) {
    assert.deepEqual(
      getToolStreamValidationFailure({
        plan: plan(toolChoiceMode),
        emittedToolCall: false,
        pendingToolProtocol: true,
      }),
      {
        message: 'Provider returned a malformed or empty tool call block for an enforced tool call',
        type: 'tool_call_parse_error',
        param: 'tool_calls',
        code: 'malformed_tool_call',
      },
    )
  }
})

test('required tool choice without a protocol block is missing', () => {
  assert.equal(
    getToolStreamValidationFailure({
      plan: plan('required'),
      emittedToolCall: false,
      pendingToolProtocol: false,
    })?.code,
    'missing_tool_call',
  )
})

test('valid tool calls and natural-language auto responses pass validation', () => {
  assert.equal(
    getToolStreamValidationFailure({
      plan: plan('required'),
      emittedToolCall: true,
      pendingToolProtocol: true,
    }),
    undefined,
  )
  assert.equal(
    getToolStreamValidationFailure({
      plan: plan('auto'),
      emittedToolCall: false,
      pendingToolProtocol: false,
    }),
    undefined,
  )
})
