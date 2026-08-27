// Environment overrides must be set before the engine module is evaluated:
// the rule constants are resolved once at import time.
process.env.CHAT2API_TOOL_CALLING_RUNTIME_RULES = 'Custom universal rule text for testing.'
process.env.CHAT2API_TRANSCRIPT_DOCUMENT_RULES = 'off'

import assert from 'node:assert/strict'
import test from 'node:test'

const { ToolCallingEngine } = await import('../../src/main/proxy/toolCalling/ToolCallingEngine.ts')
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

test('env values override or disable built-in runtime rules', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Do the task.' }],
    tools: [{
      type: 'function' as const,
      function: {
        name: 'Read',
        description: 'Read one local text file',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }],
    tool_choice: 'auto',
  }

  const turn = engine.transformRequest({
    request,
    provider: makeProvider('qwen-ai'),
    actualModel: 'qwen3.8-max',
  })
  const prompt = String(turn.messages[0].content)

  assert.match(prompt, /Custom universal rule text for testing\./)
  assert.doesNotMatch(prompt, /Never claim that an operation succeeded unless/)
  // "off" disables the transcript-document block even on qwen-ai.
  assert.doesNotMatch(prompt, /attached transcript document/)
})
