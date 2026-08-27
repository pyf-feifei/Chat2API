import assert from 'node:assert/strict'
import test from 'node:test'

import {
  prepareQwenAiMultimodalMessage,
  qwenAiSystemPromptModeFromEnv,
  qwenAiToolProtocolChannelFromEnv,
  resolveQwenAiNativeContinuationSystemPrompt,
} from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import { createManagedToolPromptMessage } from '../../src/main/proxy/toolCalling/managedPromptMetadata.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const SYSTEM_MARKER = 'CLIENT_SYSTEM_PROMPT_NATIVE_CHANNEL_9d21'
const MANAGED_MARKER = 'MANAGED_PROTOCOL_SENTINEL_4c8e'

function createStubUploader() {
  const uploadedTexts: string[] = []
  return {
    uploadedTexts,
    uploadPart: async (part: unknown) => {
      const source = JSON.stringify(part)
      const match = /data:text\/plain;base64,([A-Za-z0-9+/=]+)/.exec(source)
      uploadedTexts.push(match ? Buffer.from(match[1], 'base64').toString('utf8') : source)
      return { file: { id: `stub-${uploadedTexts.length}` }, evidence: undefined }
    },
  }
}

function archivedText(uploader: { uploadedTexts: string[] }): string {
  return uploader.uploadedTexts.join('\n')
}

function baseMessages(): ChatMessage[] {
  return [
    { role: 'system', content: `You are a coding agent.\n${SYSTEM_MARKER}: follow these rules exactly.` },
    { role: 'user', content: 'ACTIVE_USER_QUESTION final question' },
  ]
}

test('native mode routes the client system prompt out of the transcript', async () => {
  const uploader = createStubUploader()
  const prepared = await prepareQwenAiMultimodalMessage(baseMessages(), uploader as never, {
    systemPromptMode: 'native',
  })

  assert.equal(prepared.transport, 'inline')
  assert.match(prepared.nativeSystemPrompt, new RegExp(SYSTEM_MARKER))
  assert.doesNotMatch(prepared.content, /You are a coding agent/)
  assert.doesNotMatch(prepared.content, new RegExp(SYSTEM_MARKER))
  assert.match(prepared.content, /ACTIVE_USER_QUESTION/)
})

test('native mode keeps the managed tool protocol inline', async () => {
  const uploader = createStubUploader()
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_MARKER} ordinary client instructions` },
    createManagedToolPromptMessage(`${MANAGED_MARKER}\n<tools>[]</tools>`),
    { role: 'user', content: 'ACTIVE_USER_QUESTION final question' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    managedToolCalling: true,
    systemPromptMode: 'native',
  })

  assert.match(prepared.nativeSystemPrompt, new RegExp(SYSTEM_MARKER))
  assert.doesNotMatch(prepared.nativeSystemPrompt, new RegExp(MANAGED_MARKER))
  assert.match(prepared.content, new RegExp(MANAGED_MARKER), 'protocol must stay inline')
  assert.doesNotMatch(prepared.content, new RegExp(SYSTEM_MARKER), 'client prompt must not be duplicated inline')
})

test('hybrid document mode archives history without the extracted system prompt', async () => {
  const uploader = createStubUploader()
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_MARKER} keep me native` },
    { role: 'user', content: `OLD_HISTORY ${'x'.repeat(4000)}` },
    { role: 'assistant', content: 'Earlier work completed.' },
    { role: 'user', content: 'ACTIVE_USER_QUESTION final question' },
  ]
  const snapshot = structuredClone(messages)

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    transport: 'document',
    managedToolCalling: true,
    requestMaxBytes: 2000,
    systemPromptMode: 'native',
  })

  assert.equal(prepared.transport, 'document')
  assert.match(prepared.nativeSystemPrompt, new RegExp(SYSTEM_MARKER))
  assert.doesNotMatch(archivedText(uploader), new RegExp(SYSTEM_MARKER), 'archive must not carry the client prompt')
  assert.doesNotMatch(prepared.content, new RegExp(SYSTEM_MARKER))
  assert.match(prepared.content, /ACTIVE_USER_QUESTION/)
  assert.deepEqual(messages, snapshot, 'preparation must not mutate caller messages')
})

test('multiple client system messages join into one native prompt', async () => {
  const uploader = createStubUploader()
  const messages: ChatMessage[] = [
    { role: 'system', content: 'FIRST_SYSTEM_RULE' },
    { role: 'system', content: 'SECOND_SYSTEM_RULE' },
    { role: 'user', content: 'hello' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    systemPromptMode: 'native',
  })

  assert.match(prepared.nativeSystemPrompt, /FIRST_SYSTEM_RULE\n\nSECOND_SYSTEM_RULE/)
})

test('non-leading system messages stay inline even in native mode', async () => {
  const uploader = createStubUploader()
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'system', content: 'MIDDLE_SYSTEM_NOTE' },
    { role: 'user', content: 'second question' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    systemPromptMode: 'native',
  })

  assert.equal(prepared.nativeSystemPrompt, '')
  assert.match(prepared.content, /MIDDLE_SYSTEM_NOTE/)
})

test('whitespace-only system prompts do not produce a native field', async () => {
  const uploader = createStubUploader()
  const messages: ChatMessage[] = [
    { role: 'system', content: '   \n  ' },
    { role: 'user', content: 'hello' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    systemPromptMode: 'native',
  })

  assert.equal(prepared.nativeSystemPrompt, '')
})

test('flattened and absent modes keep the legacy inline behavior', async () => {
  for (const systemPromptMode of ['flattened', undefined] as const) {
    const uploader = createStubUploader()
    const prepared = await prepareQwenAiMultimodalMessage(baseMessages(), uploader as never, {
      systemPromptMode,
    })
    assert.equal(prepared.nativeSystemPrompt, '')
    assert.match(prepared.content, new RegExp(SYSTEM_MARKER), `mode=${systemPromptMode ?? 'undefined'}`)
  }
})

test('system prompt mode resolves from environment', () => {
  const previous = process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
  try {
    delete process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
    assert.equal(qwenAiSystemPromptModeFromEnv(), 'native')

    for (const value of ['flattened', 'FLATTENED', ' flattened ']) {
      process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = value
      assert.equal(qwenAiSystemPromptModeFromEnv(), 'flattened', `value=${value}`)
    }

    for (const value of ['native', 'NATIVE']) {
      process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = value
      assert.equal(qwenAiSystemPromptModeFromEnv(), 'native', `value=${value}`)
    }

    process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = 'bogus-value'
    assert.equal(qwenAiSystemPromptModeFromEnv(), 'flattened', 'unknown values fail over to the proven path')
    process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = 'off'
    assert.equal(qwenAiSystemPromptModeFromEnv(), 'flattened', "'off' disables the native channel")
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
    else process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = previous
  }
})

test('system-only requests stay on the flattened path instead of posting an empty turn', async () => {
  const uploader = createStubUploader()
  const prepared = await prepareQwenAiMultimodalMessage(
    [{ role: 'system', content: `${SYSTEM_MARKER} only rule` }],
    uploader as never,
    { systemPromptMode: 'native' },
  )

  assert.equal(prepared.nativeSystemPrompt, '', 'extraction must not empty the transcript')
  assert.match(prepared.content, new RegExp(SYSTEM_MARKER), 'system text must stay inline')
})

test('oversize native prompts fall back to flattening', async () => {
  const uploader = createStubUploader()
  const prepared = await prepareQwenAiMultimodalMessage(baseMessages(), uploader as never, {
    systemPromptMode: 'native',
    nativeSystemPromptMaxBytes: 16,
  })

  assert.equal(prepared.nativeSystemPrompt, '', 'oversize prompt must flatten')
  assert.match(prepared.content, new RegExp(SYSTEM_MARKER))
})

test('native protocol channel merges managed prompts into the native field', async () => {
  const uploader = createStubUploader()
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_MARKER} client identity` },
    createManagedToolPromptMessage(`${MANAGED_MARKER}\n<tools>[]</tools>\nNever claim completion without a tool result.`),
    { role: 'user', content: 'ACTIVE_USER_QUESTION final question' },
  ]

  const native = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    managedToolCalling: true,
    systemPromptMode: 'native',
    toolProtocolChannel: 'native',
  })

  assert.match(native.nativeSystemPrompt, new RegExp(SYSTEM_MARKER))
  assert.match(native.nativeSystemPrompt, new RegExp(MANAGED_MARKER), 'protocol must ride the native field')
  assert.match(native.nativeSystemPrompt, /Never claim completion/)
  assert.doesNotMatch(native.content, new RegExp(MANAGED_MARKER), 'protocol must not be duplicated inline')

  // Default channel keeps the verified inline layout.
  const inlineUploader = createStubUploader()
  const inline = await prepareQwenAiMultimodalMessage(baseMessages(), inlineUploader as never, {
    systemPromptMode: 'native',
  })
  assert.doesNotMatch(inline.nativeSystemPrompt, new RegExp(MANAGED_MARKER))
})

test('tool protocol channel resolves from environment', () => {
  const previous = process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL
  try {
    delete process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL
    assert.equal(qwenAiToolProtocolChannelFromEnv(), 'native', 'unset defaults to the stress-verified native channel')

    process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL = 'inline'
    assert.equal(qwenAiToolProtocolChannelFromEnv(), 'inline', "'inline' is the one-line rollback")

    for (const value of ['native', 'NATIVE']) {
      process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL = value
      assert.equal(qwenAiToolProtocolChannelFromEnv(), 'native', `value=${value}`)
    }

    process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL = 'bogus-value'
    assert.equal(qwenAiToolProtocolChannelFromEnv(), 'inline', 'unknown values fail over to the original path')
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL
    else process.env.CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL = previous
  }
})

test('continuation system prompt mirrors round-1 gating', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_MARKER} resend me on continuations` },
    { role: 'user', content: 'active question' },
  ]

  const previousMode = process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
  const previousCap = process.env.CHAT2API_QWEN_AI_NATIVE_SYSTEM_MAX_BYTES
  try {
    delete process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
    delete process.env.CHAT2API_QWEN_AI_NATIVE_SYSTEM_MAX_BYTES
    assert.match(resolveQwenAiNativeContinuationSystemPrompt(messages), new RegExp(SYSTEM_MARKER))

    process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = 'flattened'
    assert.equal(resolveQwenAiNativeContinuationSystemPrompt(messages), '', 'flattened mode sends no continuation field')

    delete process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
    process.env.CHAT2API_QWEN_AI_NATIVE_SYSTEM_MAX_BYTES = '8'
    assert.equal(
      resolveQwenAiNativeContinuationSystemPrompt(messages),
      '',
      'oversize prompts stay consistent with the round-1 fallback',
    )
  } finally {
    if (previousMode === undefined) delete process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE
    else process.env.CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE = previousMode
    if (previousCap === undefined) delete process.env.CHAT2API_QWEN_AI_NATIVE_SYSTEM_MAX_BYTES
    else process.env.CHAT2API_QWEN_AI_NATIVE_SYSTEM_MAX_BYTES = previousCap
  }
})
