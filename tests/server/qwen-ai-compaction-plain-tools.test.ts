import assert from 'node:assert/strict'
import test from 'node:test'

import {
  prepareQwenAiMultimodalMessage,
} from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// Context-compaction requests must render tool history WITHOUT protocol
// envelopes: the summary copies whatever envelope shapes it sees, and a
// reproduced ` tool_result` wrapper fails the client stream. The
// same facts must survive, and normal workflow requests must keep the
// protocol formatters.

function baseMessages(): ChatMessage[] {
  return [
    { role: 'system', content: 'Summarize the conversation for continuation.' },
    { role: 'user', content: 'Run the build for module-1.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_build_1',
        type: 'function',
        function: { name: 'exec_command', arguments: '{"cmd":"build module-1"}' },
      }],
    } as ChatMessage,
    { role: 'tool', tool_call_id: 'call_build_1', content: 'Build failed: src/app.ts:1 missing export', is_error: true },
    { role: 'user', content: 'Return only the context summary; do not call tools.' },
  ]
}

function createStubUploader() {
  return {
    uploadPart: async () => ({ file: { id: 'stub-1' }, evidence: undefined }),
  }
}

test('compaction renders tool history as plain prose without wrapper markers', async () => {
  const prepared = await prepareQwenAiMultimodalMessage(baseMessages(), createStubUploader() as never, {
    requestIntent: 'context_compaction',
  })

  const haystack = `${prepared.content}\n${prepared.nativeSystemPrompt}`
  assert.doesNotMatch(haystack, /<\|CHAT2API\|/, 'managed envelope must not appear')
  assert.doesNotMatch(haystack, / tool_result|<\/tool_result/, 'hermes result wrapper must not appear')
  assert.doesNotMatch(haystack, /<tool_call>/, 'hermes call wrapper must not appear')
  assert.doesNotMatch(haystack, /<function_results|<\/function_results>/, 'function_results wrapper must not appear')
  assert.doesNotMatch(haystack, /<tool_result>|<\/tool_result>/, 'xml result wrapper must not appear')
  assert.match(prepared.content, /exec_command/)
  assert.match(prepared.content, /build module-1/, 'call arguments preserved')
  assert.match(prepared.content, /Build failed: src\/app\.ts:1 missing export/, 'tool result facts preserved')
  assert.match(prepared.content, /status: error/, 'error status preserved')
})

test('normal workflow requests keep the protocol transcript format', async () => {
  const prepared = await prepareQwenAiMultimodalMessage(baseMessages(), createStubUploader() as never, {
    requestIntent: 'normal',
  })

  assert.match(prepared.content, / tool_result|</)
  assert.match(prepared.content, /exec_command/)
})

test('compaction transcript format is identical across retries', async () => {
  const first = await prepareQwenAiMultimodalMessage(baseMessages(), createStubUploader() as never, {
    requestIntent: 'context_compaction',
  })
  const second = await prepareQwenAiMultimodalMessage(baseMessages(), createStubUploader() as never, {
    requestIntent: 'context_compaction',
    retryNonce: 2,
  })
  assert.equal(first.content, second.content, 'retry nonce must not alter the inline compaction turn')
})
