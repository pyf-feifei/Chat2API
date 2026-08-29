import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { Provider } from '../../src/main/store/types.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'

function makeProvider(id: string): Provider {
  return {
    id,
    name: id,
    type: 'builtin',
    authType: 'jwt',
    apiEndpoint: 'https://example.invalid',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as Provider
}

const tools = [{
  type: 'function' as const,
  function: {
    name: 'Read',
    description: 'Read one local text file',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
}]

test('runtime rules follow provider profile capabilities by default', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Do the task.' }],
    tools,
    tool_choice: 'auto',
  }

  const qwenTurn = engine.transformRequest({
    request,
    provider: makeProvider('qwen-ai'),
    actualModel: 'qwen3.8-max',
  })
  const qwenPrompt = String(qwenTurn.messages[0].content)
  // Universal rule applies to every managed-tool provider.
  assert.match(qwenPrompt, /Never claim that an operation succeeded unless/)
  // Transcript-document rules ride the profile capability.
  assert.match(qwenPrompt, /attached transcript document/)
  // Reading an attached transcript is preparation, not the turn deliverable.
  assert.match(qwenPrompt, /preparation for the current turn, not the deliverable/)
  // Provider-capability exclusion rides its own profile capability (distinct
  // wording from managed_xml's own protocol-level exclusion sentence).
  assert.match(qwenPrompt, /never invoke, rely on, or answer from undeclared provider-side tools/)

  const deepseekTurn = engine.transformRequest({
    request,
    provider: makeProvider('deepseek'),
    actualModel: 'deepseek-chat',
  })
  const deepseekPrompt = String(deepseekTurn.messages[0].content)
  assert.match(deepseekPrompt, /Never claim that an operation succeeded unless/)
  assert.doesNotMatch(deepseekPrompt, /attached transcript document/)
  // managed_xml keeps its own protocol-level exclusion wording; the
  // profile-gated capability block must not add the qwen-ai wording there.
  assert.doesNotMatch(deepseekPrompt, /never invoke, rely on, or answer from undeclared provider-side tools/)

  const m365Turn = engine.transformRequest({
    request,
    provider: makeProvider('m365-copilot'),
    actualModel: 'gpt-5.6-sol',
  })
  const m365Prompt = String(m365Turn.messages[0].content)
  assert.doesNotMatch(m365Prompt, /undeclared provider-side tools/)
})
