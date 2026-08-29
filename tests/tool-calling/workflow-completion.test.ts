import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createToolWorkflowContinuationMessage,
  extractLatestActiveUserRequest,
  ToolCallingEngine,
} from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import {
  hasManagedWorkflowCompletionMarker,
  parseManagedWorkflowCompletionProof,
  requiresManagedWorkflowCompletionMarker,
  stripManagedWorkflowCompletionMarker,
  supportsManagedWorkflowCompletionMarker,
} from '../../src/main/proxy/toolCalling/workflowCompletion.ts'
import type { Provider } from '../../src/main/store/types.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function managedPlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'qwen_hermes',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen-ai',
    tools: [{ name: 'workspace:read_file', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['workspace:read_file']),
    workflowContinuation: false,
    failedToolResultPending: false,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen-ai',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'qwen_hermes',
      toolCount: 1,
      injected: true,
      reason: 'test',
      workflowContinuation: false,
      failedToolResultPending: false,
    },
    ...overrides,
  }
}

test('initial Qwen managed auto turns require a workflow completion marker', () => {
  assert.equal(requiresManagedWorkflowCompletionMarker(managedPlan()), true)
})

test('successful tool-result continuations require a completion proof', () => {
  const plan = managedPlan({ workflowContinuation: true })
  assert.equal(supportsManagedWorkflowCompletionMarker(plan), true)
  assert.equal(requiresManagedWorkflowCompletionMarker(plan), true)
  assert.deepEqual(
    parseManagedWorkflowCompletionProof(
      'The work is complete.<chat2api_workflow_complete/>',
      plan,
    ),
    { complete: true, content: 'The work is complete.' },
  )
})

test('completion proof strips the model-emitted marker variant without a slash', () => {
  const content = 'The work is complete.<chat2api_workflow_complete>'
  assert.deepEqual(
    parseManagedWorkflowCompletionProof(content, managedPlan()),
    { complete: true, content: 'The work is complete.' },
  )
  assert.equal(stripManagedWorkflowCompletionMarker(content, managedPlan()), 'The work is complete.')
})

test('failed-result continuations may explain the blocking failure without a marker', () => {
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({
      workflowContinuation: true,
      failedToolResultPending: true,
    })),
    false,
  )
})

test('Qwen required and forced tool choices require a completion marker', () => {
  for (const toolChoiceMode of ['required', 'forced'] as const) {
    assert.equal(
      requiresManagedWorkflowCompletionMarker(managedPlan({ toolChoiceMode })),
      true,
    )
  }
})

test('completion markers follow managed protocol capability instead of provider instance id', () => {
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ providerId: 'custom-qwen-instance' })),
    true,
  )
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ protocol: 'managed_xml' })),
    false,
  )
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ shouldParseResponse: false })),
    false,
  )
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ allowedToolNames: new Set() })),
    false,
  )
})

test('completion proof is valid only as one terminal marker for the capable protocol', () => {
  const plan = managedPlan({ providerId: 'custom-provider-instance' })
  const valid = 'Work completed.\n<chat2api_workflow_complete/>   \n'
  const midAnswer = 'Progress <chat2api_workflow_complete/> still running.'
  const duplicated = 'Done.<chat2api_workflow_complete/><chat2api_workflow_complete/>'
  const separatedDuplicate = 'Example <chat2api_workflow_complete/>\nDone.<chat2api_workflow_complete/>'
  const fenced = '```xml\n<chat2api_workflow_complete/>'
  const tildeFenced = '~~~xml\n<chat2api_workflow_complete/>'
  const indentedCode = '    <chat2api_workflow_complete/>'
  const quoted = '> <chat2api_workflow_complete/>'

  assert.equal(hasManagedWorkflowCompletionMarker(valid, plan), true)
  assert.equal(stripManagedWorkflowCompletionMarker(valid, plan), 'Work completed.')
  for (const content of [
    midAnswer,
    duplicated,
    separatedDuplicate,
    fenced,
    tildeFenced,
    indentedCode,
    quoted,
  ]) {
    assert.equal(hasManagedWorkflowCompletionMarker(content, plan), false)
    assert.equal(stripManagedWorkflowCompletionMarker(content, plan), content)
  }
  assert.equal(hasManagedWorkflowCompletionMarker(valid), false)
  assert.equal(
    hasManagedWorkflowCompletionMarker(valid, managedPlan({ protocol: 'managed_xml' })),
    false,
  )
  assert.equal(
    hasManagedWorkflowCompletionMarker(
      '~~~xml\nexample\n~~~\nDone.<chat2api_workflow_complete/>',
      plan,
    ),
    true,
  )
})

test('marker-only proof remains distinguishable from a visible final answer', () => {
  assert.deepEqual(
    parseManagedWorkflowCompletionProof('<chat2api_workflow_complete/>', managedPlan()),
    { complete: true, content: '' },
  )
})

test('workflow continuation completion proof follows protocol state and capability', () => {
  const hermes = createToolWorkflowContinuationMessage({ plan: managedPlan() })
  const successfulHermes = createToolWorkflowContinuationMessage({
    plan: managedPlan({ workflowContinuation: true }),
  })
  const failedHermes = createToolWorkflowContinuationMessage({
    failedToolResultPending: true,
    plan: managedPlan({ workflowContinuation: true, failedToolResultPending: true }),
  })
  const managedXml = createToolWorkflowContinuationMessage({
    plan: managedPlan({ protocol: 'managed_xml' }),
  })

  assert.match(String(hermes.content), /chat2api_workflow_complete/)
  assert.match(String(hermes.content), /transport marker.*proxy removes it before delivery/i)
  assert.match(String(successfulHermes.content), /chat2api_workflow_complete/)
  assert.match(String(successfulHermes.content), /tool-result batch completed successfully/i)
  assert.match(String(successfulHermes.content), /do not repeat a completed call/i)
  assert.doesNotMatch(String(failedHermes.content), /chat2api_workflow_complete/)
  assert.match(String(failedHermes.content), /otherwise explain the blocking failure/i)
  assert.doesNotMatch(String(failedHermes.content), /completed successfully/i)
  assert.doesNotMatch(String(failedHermes.content), /Return only one or more Qwen function calls/i)
  assert.doesNotMatch(String(managedXml.content), /chat2api_workflow_complete/)
})

test('workflow continuation serializes the active user request as one JSON-encoded value', () => {
  const activeUserRequest = 'ACTIVE_TASK_B_SENTINEL\n```\nEarlier-looking text: OLD_TASK_A'
  const continuation = createToolWorkflowContinuationMessage({
    activeUserRequest,
    plan: managedPlan(),
  })
  const content = String(continuation.content)

  assert.match(content, /ACTIVE_TASK_B_SENTINEL/)
  assert.match(content, new RegExp(JSON.stringify(activeUserRequest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('workflow continuation explains a missing completion proof without accepting marker-only output', () => {
  const continuation = createToolWorkflowContinuationMessage({
    activeUserRequest: 'ACTIVE_TASK_B_SENTINEL',
    completionProofMissing: true,
    plan: managedPlan(),
  })
  const content = String(continuation.content)

  assert.match(content, /preceding assistant branch was rejected.*omitted/i)
  assert.match(content, /reissue the complete final answer/i)
  assert.match(content, /do not return the marker alone/i)
})

test('managed workflow continuations restate the protocol contract next to the tool results', () => {
  for (const protocol of ['qwen_native', 'qwen_hermes'] as const) {
    const plan = managedPlan({
      protocol,
      workflowContinuation: true,
      tools: [
        { name: 'workspace:read_file', parameters: {}, source: 'openai' },
        { name: 'workspace:write_file', parameters: {}, source: 'openai' },
      ],
      allowedToolNames: new Set(['workspace:read_file', 'workspace:write_file']),
    })
    const continuation = createToolWorkflowContinuationMessage({ plan })
    const content = String(continuation.content)

    // Workflow fact is asserted, not left to model self-judgment.
    assert.match(content, /Managed tool workflow status: IN PROGRESS/, `${protocol} states the workflow fact`)
    assert.match(content, /tool results above were just returned/, `${protocol} anchors the fact to this turn`)
    // Intent prose is explicitly a violation on the continuation turn.
    assert.match(content, /plan, progress update, or a description/, `${protocol} forbids intent prose`)
    // The declared tool names ride the reminder — no reliance on the distant
    // teaching system prompt.
    assert.match(content, /workspace:read_file/, `${protocol} lists tool names`)
    assert.match(content, /workspace:write_file/, `${protocol} lists every tool name`)
    // The wire format example is restated next to the tool results.
    const formatTag = protocol === 'qwen_native' ? 'function_calls' : 'tool_call'
    assert.match(content, new RegExp(`<${formatTag}>`), `${protocol} restates the call format`)
  }
})

test('non-continuation managed turns do not carry the continuation reminder', () => {
  const continuation = createToolWorkflowContinuationMessage({ plan: managedPlan() })
  assert.doesNotMatch(String(continuation.content), /Managed tool workflow status/)
})

test('protocols without a continuation reminder still render a valid continuation message', () => {
  const plan = managedPlan({ protocol: 'managed_xml', workflowContinuation: true })
  const continuation = createToolWorkflowContinuationMessage({ plan })
  assert.doesNotMatch(String(continuation.content), /Managed tool workflow status/)
  assert.match(String(continuation.content), /Complete the active user request/)
})

test('failed-result continuations keep the relaxed no-marker contract', () => {
  const plan = managedPlan({
    protocol: 'qwen_native',
    workflowContinuation: true,
    failedToolResultPending: true,
  })
  const continuation = createToolWorkflowContinuationMessage({
    failedToolResultPending: true,
    plan,
  })
  const content = String(continuation.content)

  // The failure path deliberately allows a final blocking-failure explanation
  // without the completion marker; the reminder must not tighten that.
  assert.doesNotMatch(content, /chat2api_workflow_complete/)
  assert.doesNotMatch(content, /Managed tool workflow status: IN PROGRESS/)
  assert.match(content, /otherwise explain the blocking failure/i)
})

test('active user request extraction skips tool results and excludes non-text parts', () => {
  const messages = [
    { role: 'user', content: 'OLD_TASK_A' },
    { role: 'assistant', content: 'OLD_ANSWER_A' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'ACTIVE_TASK_B_SENTINEL' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,ATTACHMENT_MUST_NOT_LEAK' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'TOOL_RESULT_MUST_NOT_WIN' }],
    },
  ] as unknown as Parameters<typeof extractLatestActiveUserRequest>[0]

  assert.equal(extractLatestActiveUserRequest(messages), 'ACTIVE_TASK_B_SENTINEL')
})

test('active user request extraction keeps text beside a tool result', () => {
  const messages = [
    { role: 'user', content: 'OLD_TASK_A' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'tool output' },
        { type: 'text', text: 'ACTIVE_TASK_B_SENTINEL' },
      ],
    },
  ] as unknown as Parameters<typeof extractLatestActiveUserRequest>[0]

  assert.equal(extractLatestActiveUserRequest(messages), 'ACTIVE_TASK_B_SENTINEL')
})

test('active user request extraction does not fall back past an attachment-only user turn', () => {
  const messages = [
    { role: 'user', content: 'OLD_TASK_A' },
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ACTIVE_ATTACHMENT' } }],
    },
  ] as Parameters<typeof extractLatestActiveUserRequest>[0]

  assert.equal(extractLatestActiveUserRequest(messages), undefined)
})

const qwenAiProvider = {
  id: 'qwen-ai',
  name: 'Qwen AI',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const declaredTools = [{
  type: 'function' as const,
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}]

test('initial Qwen auto prompt injects a private completion proof', () => {
  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'configured-model',
      messages: [{ role: 'user', content: 'read the file when needed' }],
      tools: declaredTools,
      tool_choice: 'auto',
    },
    provider: qwenAiProvider,
    actualModel: 'configured-model',
  })

  assert.match(String(transformed.messages[0].content), /chat2api_workflow_complete/)
})

test('Qwen required-tool prompt keeps the bounded completion proof', () => {
  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'configured-model',
      messages: [{ role: 'user', content: 'read the file' }],
      tools: declaredTools,
      tool_choice: 'required',
    },
    provider: qwenAiProvider,
    actualModel: 'configured-model',
  })

  assert.match(String(transformed.messages[0].content), /chat2api_workflow_complete/)
})

test('long matched tool history opens a completion-proved final-answer turn', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'complete the requested work' }]
  for (let index = 0; index < 108; index += 1) {
    const id = `call-${index}`
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${index}` }) },
      }],
    })
    messages.push({ role: 'tool', tool_call_id: id, content: `result-${index}` })
  }

  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'configured-model',
      messages,
      tools: declaredTools,
      tool_choice: 'auto',
    },
    provider: qwenAiProvider,
    actualModel: 'configured-model',
  })

  assert.equal(transformed.plan.workflowContinuation, true)
  assert.equal(requiresManagedWorkflowCompletionMarker(transformed.plan), true)
  assert.match(String(transformed.messages[0].content), /chat2api_workflow_complete/)
})
