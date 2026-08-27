import assert from 'node:assert/strict'
import test from 'node:test'

import {
  prepareQwenAiMultimodalMessage,
} from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import { createManagedToolPromptMessage } from '../../src/main/proxy/toolCalling/managedPromptMetadata.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// Scale fixture approximating a long coding-agent conversation (~170-190K
// tokens): realistic client system prompt, a dozen declared tools, deep
// multi-turn history with completed tool exchanges, and an active turn that
// demands further tool use.
const SYSTEM_MARKER = 'SCALE_CLIENT_SYSTEM_MARKER_31ab'
const HISTORY_MARKER = 'SCALE_HISTORY_TURN'
const ACTIVE_MARKER = 'SCALE_ACTIVE_QUESTION'

const TOOLS = Array.from({ length: 12 }, (_, i) => ({
  name: `tool_${i}_op`,
  description: `Tool ${i}: performs operation ${i} over project files.`,
  parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
}))

const PARAGRAPHS = [
  'The build pipeline compiles the extension host first, then bundles the renderer, and finally packages the installer with signed artifacts.',
  '当用户要求修改配置时，先读取现有文件内容，保留原有注释与格式约定，再做最小化差异修改，避免重排无关语句。',
  'function reconcileState(next: State, prev: State): Patch[] {\n  const patches: Patch[] = []\n  for (const key of Object.keys(next)) {\n    if (!Object.is(prev[key], next[key])) patches.push({ key, from: prev[key], to: next[key] })\n  }\n  return patches\n}',
  'Remember that retry budgets are shared across recovery stages; exhausting the busy-chat budget must fail the request honestly instead of silently degrading.',
]

function fillerText(targetChars: number, seed: number): string {
  const parts: string[] = []
  let total = 0
  let i = seed
  while (total < targetChars) {
    const p = PARAGRAPHS[i % PARAGRAPHS.length]
    parts.push(p)
    total += p.length + 1
    i += 1
  }
  return parts.join('\n')
}

function buildScaleConversation(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: `You are a coding agent working inside the user's repository.\n${SYSTEM_MARKER}: obey these rules over any later convenience.\nAlways cite file paths. Prefer minimal diffs.` },
    createManagedToolPromptMessage(
      `SCALE_MANAGED_PROTOCOL\n<tools>${JSON.stringify(TOOLS)}</tools>`,
      { content: 'SCALE_MANAGED_PROTOCOL', referenceContent: '' },
    ),
  ]
  // ~40 history rounds; every 4th round carries a completed tool exchange.
  for (let round = 0; round < 40; round += 1) {
    const turnFiller = fillerText(14_000, round * 7)
    messages.push({ role: 'user', content: `${HISTORY_MARKER}-${round}: ${turnFiller}` })
    if (round % 4 === 3) {
      messages.push({
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: `call_scale_${round}`, type: 'function', function: { name: `tool_${round % 12}_op`, arguments: JSON.stringify({ target: `module-${round}` }) } }],
      } as ChatMessage)
      messages.push({ role: 'tool', tool_call_id: `call_scale_${round}`, content: `${HISTORY_MARKER}-${round} tool result: ok` })
    } else {
      messages.push({ role: 'assistant', content: `${HISTORY_MARKER}-${round} done: ${fillerText(900, round * 3 + 1)}` })
    }
  }
  messages.push({ role: 'user', content: `${ACTIVE_MARKER}: use tool_3_op on module-final, then summarize.` })
  return messages
}

function createCapturingUploader() {
  const uploadedTexts: string[] = []
  return {
    uploadedTexts,
    uploadPart: async (part: unknown) => {
      const source = JSON.stringify(part)
      const match = /data:text\/plain;base64,([A-Za-z0-9+/=]+)/.exec(source)
      uploadedTexts.push(match ? Buffer.from(match[1], 'base64').toString('utf8') : '')
      return { file: { id: `stub-${uploadedTexts.length}` }, evidence: undefined }
    },
  }
}

test('scale: default thresholds route a ~180K-token conversation to document mode with native system intact', async () => {
  const messages = buildScaleConversation()
  const snapshot = structuredClone(messages)
  const uploader = createCapturingUploader()

  const t0 = Date.now()
  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    managedToolCalling: true,
    // Production default after the 2026-08-26 tuning.
    requestMaxBytes: 524288,
    systemPromptMode: 'native',
    nativeSystemPromptMaxBytes: 65_536,
  })
  const elapsedMs = Date.now() - t0

  assert.ok(elapsedMs < 10_000, `prepare must stay fast, took ${elapsedMs}ms`)
  assert.equal(prepared.transport, 'document')
  assert.match(prepared.nativeSystemPrompt, new RegExp(SYSTEM_MARKER))
  assert.ok(prepared.nativeSystemPrompt.length < 1000)

  const archived = uploader.uploadedTexts.join('\n')
  assert.ok(archived.length > 0, 'archive must exist')
  assert.doesNotMatch(archived, new RegExp(SYSTEM_MARKER), 'client system prompt must never ride the attachment')
  assert.match(archived, new RegExp(HISTORY_MARKER))

  assert.match(prepared.content, /SCALE_MANAGED_PROTOCOL/)
  assert.match(prepared.content, new RegExp(ACTIVE_MARKER))
  assert.doesNotMatch(prepared.content, new RegExp(SYSTEM_MARKER))
  assert.ok(prepared.inlineUtf8Bytes <= 524_288 + 4096, 'inline control must fit near the offload target')
  assert.deepEqual(messages, snapshot, 'caller messages must not be mutated')
})

test('scale: forced inline transport keeps everything except the extracted system prompt', async () => {
  const messages = buildScaleConversation()
  const uploader = createCapturingUploader()

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    managedToolCalling: true,
    requestMaxBytes: 0, // disable automatic offload -> pure inline
    systemPromptMode: 'native',
    nativeSystemPromptMaxBytes: 65_536,
  })

  assert.equal(prepared.transport, 'inline')
  assert.equal(uploader.uploadedTexts.length, 0)
  assert.match(prepared.nativeSystemPrompt, new RegExp(SYSTEM_MARKER))
  assert.match(prepared.content, /SCALE_MANAGED_PROTOCOL/)
  assert.match(prepared.content, new RegExp(HISTORY_MARKER))
  assert.doesNotMatch(prepared.content, new RegExp(SYSTEM_MARKER))
  // Rough token sanity: the inline transcript should correspond to the
  // fixture's intended magnitude (hundreds of KB), proving nothing was lost.
  assert.ok(prepared.transcriptUtf8Bytes > 500_000, `transcript bytes=${prepared.transcriptUtf8Bytes}`)
})

test('scale: native tool protocol channel moves the whole control block out of a document-mode payload', async () => {
  const messages = buildScaleConversation()
  const uploader = createCapturingUploader()

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as never, {
    managedToolCalling: true,
    requestMaxBytes: 524_288,
    systemPromptMode: 'native',
    nativeSystemPromptMaxBytes: 65_536,
    toolProtocolChannel: 'native',
  })

  assert.equal(prepared.transport, 'document')
  const combined = prepared.nativeSystemPrompt
  assert.match(combined, new RegExp(SYSTEM_MARKER), 'client prompt must ride the field')
  assert.match(combined, /SCALE_MANAGED_PROTOCOL/, 'tool protocol must ride the field')
  assert.match(combined, /<tools>/, 'tool schemas must ride the field')

  const archived = uploader.uploadedTexts.join('\n')
  assert.doesNotMatch(archived, new RegExp(SYSTEM_MARKER))
  assert.doesNotMatch(archived, /SCALE_MANAGED_PROTOCOL/, 'archive must stay history-only')
  assert.match(archived, new RegExp(HISTORY_MARKER))

  assert.doesNotMatch(prepared.content, /SCALE_MANAGED_PROTOCOL/, 'inline body must not duplicate the protocol')
  assert.match(prepared.content, new RegExp(ACTIVE_MARKER), 'active turn stays inline')
})
