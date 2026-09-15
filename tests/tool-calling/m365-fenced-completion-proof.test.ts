import assert from 'node:assert/strict'
import test from 'node:test'

import { m365FencedProtocol } from '../../src/main/proxy/toolCalling/protocols/m365Fenced.ts'
import { renderManagedTailRestatement } from '../../src/main/proxy/toolCalling/m365Transcript.ts'
import {
  hasManagedWorkflowCompletionMarker,
  parseManagedWorkflowCompletionProof,
  requiresManagedWorkflowCompletionMarker,
  stripManagedWorkflowCompletionMarker,
  supportsManagedWorkflowCompletionMarker,
} from '../../src/main/proxy/toolCalling/workflowCompletion.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function m365Plan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'm365_fenced',
    clientAdapterId: 'codex_responses',
    providerId: 'm365-copilot',
    tools: [{ name: 'shell', parameters: { type: 'object', properties: {} }, source: 'responses' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['shell']),
    workflowContinuation: false,
    failedToolResultPending: false,
    hasLiveToolWorkflow: false,
    diagnostics: { requestId: 'test-req' },
    ...overrides,
  }
}

test('m365_fenced plans support and require the workflow completion marker', () => {
  assert.equal(supportsManagedWorkflowCompletionMarker(m365Plan()), true)
  // First turn (workflowContinuation false) already requires the proof so a
  // marker-less final answer can never classify as deliverable.
  assert.equal(requiresManagedWorkflowCompletionMarker(m365Plan()), true)
  assert.equal(requiresManagedWorkflowCompletionMarker(m365Plan({ workflowContinuation: true })), true)
})

test('m365 teaching prompt teaches the fenced call and the completion marker', () => {
  const prompt = m365FencedProtocol.renderPrompt(m365Plan().tools as never)
  // Wire format contract stays intact.
  assert.match(prompt, /```<tool_name>/)
  assert.match(prompt, /Emit exactly ONE fenced tool call per turn/)
  // Final-answer proof requirement is part of the taught contract.
  assert.match(prompt, /completion marker/)
})

test('m365 parse leaves the marker for the proof layer instead of treating it as prose', () => {
  const content = 'Checking the file first.\n```shell\ncommand: cat prompt.md\n```\n'
  const parsed = m365FencedProtocol.parse(content, {
    tools: m365Plan().tools as never,
    protocol: 'm365_fenced',
    allowPartial: false,
  })
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'shell')

  const final = 'The answer is 4.<chat2api_workflow_complete/>'
  assert.deepEqual(
    parseManagedWorkflowCompletionProof(final, m365Plan()),
    { complete: true, content: 'The answer is 4.' },
  )
  assert.equal(stripManagedWorkflowCompletionMarker(final, m365Plan()), 'The answer is 4.')
  assert.equal(hasManagedWorkflowCompletionMarker(final, m365Plan()), true)
})

test('m365 proof parse rejects an answer that quotes the marker earlier in prose', () => {
  // The visibility guard treats a documented literal marker occurrence as
  // non-proof, so the whole answer classifies as marker-less instead of
  // letting a quoted marker masquerade as the proof.
  const content = 'Use <chat2api_workflow_complete/> literally as documented.<chat2api_workflow_complete/>'
  assert.equal(parseManagedWorkflowCompletionProof(content, m365Plan()).complete, false)
  assert.equal(hasManagedWorkflowCompletionMarker(content, m365Plan()), false)
})

test('managed tail restatement derives declared tool names without hardcoding', () => {
  assert.equal(renderManagedTailRestatement([]), '')
  const tail = renderManagedTailRestatement([{ name: 'shell' }, { name: 'update_plan' }])
  assert.match(tail, /shell, update_plan/)
  assert.match(tail, /never simulate, describe, or fabricate tool output/)
  assert.match(tail, /<chat2api_workflow_complete\/>/)
})
