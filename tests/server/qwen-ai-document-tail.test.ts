import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareQwenAiMultimodalMessage } from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const TAIL_OPEN = '[Archived transcript tail — truncated; the attached transcript remains the authoritative complete record]'
const TAIL_CLOSE = '[/Archived transcript tail]'

/** Reproduces the failure-A shape: one oversized user message whose operative
 *  task sentence sits at the very end, archived wholesale by complete mode. */
function buildSingleMessageCorpus(): string {
  const filler = 'The quick brown fox jumps over the lazy dog while the harbor lights flicker. '.repeat(3000)
  return `Reference document follows (filler, ignore).\n\n${filler}\n\nEnd of filler.\n\nTASK-SENTINEL-7d4f: What is the weather in Tokyo? Call the tool.`
}

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

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    })
}

test('complete document mode keeps an inline transcript tail with the pending task', async () => {
  await withEnv({ CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: undefined }, async () => {
    const uploader = createStubUploader()
    const prepared = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: buildSingleMessageCorpus() }],
      uploader as never,
      {
        transport: 'document',
        managedToolCalling: true,
        requestMaxBytes: 90 * 1024,
      },
    )

    assert.equal(prepared.transport, 'document')
    assert.equal(prepared.managedDocumentMode, 'complete')

    // Tail bracket present and holds the operative task (a single-message
    // transcript is one part, so the tail legitimately opens mid-part after
    // the boundary snap; the continuation-shape test covers part-boundary
    // snapping where multiple parts exist).
    assert.match(prepared.content, new RegExp(TAIL_OPEN.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const tailMatch = prepared.content.split(TAIL_OPEN)[1]?.split(TAIL_CLOSE)[0] ?? ''
    assert.match(tailMatch, /TASK-SENTINEL-7d4f/)
    assert.ok(tailMatch.length > 0 && tailMatch.length < 20_000, 'tail must be a bounded excerpt')

    // Pointer names the real transcript document and forbids acknowledgment-only replies.
    assert.match(prepared.content, /chat2api-conversation-[a-f0-9]+\.txt/)
    assert.match(prepared.content, /Never reply with only an acknowledgment/)

    // The attachment keeps the complete untruncated transcript.
    const archived = uploader.uploadedTexts.join('\n')
    assert.match(archived, /TASK-SENTINEL-7d4f/)
    assert.match(archived, /Reference document follows/)
    assert.ok(!archived.includes(TAIL_OPEN), 'attachment must not carry the truncation bracket')
  })
})

test('document inline tail follows CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES', async () => {
  const corpus = buildSingleMessageCorpus()
  await withEnv({ CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: '0' }, async () => {
    const uploader = createStubUploader()
    const prepared = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: corpus }],
      uploader as never,
      { transport: 'document', managedToolCalling: true, requestMaxBytes: 90 * 1024 },
    )
    assert.ok(!prepared.content.includes(TAIL_OPEN), 'tail=0 must disable the excerpt')
    // Pointer degrades: no tail-reference sentence.
    assert.doesNotMatch(prepared.content, /inline tail below repeats/)
  })

  await withEnv({ CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: 'abc' }, async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message: string) => { warnings.push(String(message)) }
    try {
      const uploader = createStubUploader()
      const prepared = await prepareQwenAiMultimodalMessage(
        [{ role: 'user', content: corpus }],
        uploader as never,
        { transport: 'document', managedToolCalling: true, requestMaxBytes: 90 * 1024 },
      )
      assert.match(prepared.content, /TASK-SENTINEL-7d4f/, 'invalid value falls back to the default tail')
    } finally {
      console.warn = originalWarn
    }
    assert.ok(
      warnings.some(w => w.includes('CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES')),
      'invalid value must warn once',
    )
  })
})

test('document inline tail is clamped to the offload target headroom', async () => {
  await withEnv({ CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: '12288' }, async () => {
    const uploader = createStubUploader()
    // Tiny offload target leaves no headroom once the pointer is accounted.
    const prepared = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: buildSingleMessageCorpus() }],
      uploader as never,
      { transport: 'document', managedToolCalling: true, requestMaxBytes: 600 },
    )
    assert.equal(prepared.managedDocumentMode, 'complete')
    assert.ok(!prepared.content.includes(TAIL_OPEN), 'no headroom means no tail')
    // requestMaxBytes 0 (offload disabled as a target) grants the full budget.
    const uploader2 = createStubUploader()
    const prepared2 = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: buildSingleMessageCorpus() }],
      uploader2 as never,
      { transport: 'document', managedToolCalling: true, managedDocumentMode: 'complete', requestMaxBytes: 0 },
    )
    assert.match(prepared2.content, /TASK-SENTINEL-7d4f/)
  })
})

test('hybrid document mode does not gain a transcript tail', async () => {
  await withEnv({ CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: undefined }, async () => {
    const uploader = createStubUploader()
    const messages: ChatMessage[] = [
      { role: 'user', content: `OLD_HISTORY_SENTINEL:${'x'.repeat(200_000)}` },
      { role: 'assistant', content: 'acknowledged.' },
      { role: 'user', content: 'ACTIVE_QUESTION_SENTINEL: what is next?' },
    ]
    const prepared = await prepareQwenAiMultimodalMessage(
      messages,
      uploader as never,
      { transport: 'document', managedToolCalling: true, requestMaxBytes: 90 * 1024 },
    )
    assert.equal(prepared.managedDocumentMode, 'hybrid')
    assert.ok(!prepared.content.includes(TAIL_OPEN), 'hybrid keeps the active message inline already')
    assert.match(prepared.content, /ACTIVE_QUESTION_SENTINEL/)
    // Hybrid pointer no longer orders read-before-tool.
    assert.doesNotMatch(prepared.content, /Read it first/)
  })
})

test('transcript pointer prompts are env-overridable with {filename} and off', async () => {
  const corpus = buildSingleMessageCorpus()
  await withEnv({
    CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: '0',
    CHAT2API_QWEN_AI_TRANSCRIPT_POINTER_PROMPT_COMPLETE: 'CUSTOM-POINTER-9b2e for {filename}',
  }, async () => {
    const uploader = createStubUploader()
    const prepared = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: corpus }],
      uploader as never,
      { transport: 'document', managedToolCalling: true, requestMaxBytes: 90 * 1024 },
    )
    assert.match(prepared.content, /CUSTOM-POINTER-9b2e for chat2api-conversation-[a-f0-9]+\.txt/)
    assert.doesNotMatch(prepared.content, /Never reply with only an acknowledgment/)
  })

  await withEnv({
    CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: '0',
    CHAT2API_QWEN_AI_TRANSCRIPT_POINTER_PROMPT_COMPLETE: 'off',
  }, async () => {
    const uploader = createStubUploader()
    const prepared = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: corpus }],
      uploader as never,
      { transport: 'document', managedToolCalling: true, requestMaxBytes: 90 * 1024 },
    )
    assert.doesNotMatch(prepared.content, /complete managed conversation transcript is attached/i)
    assert.ok(uploader.uploadedTexts.length >= 1, 'attachment still uploads without the pointer sentence')
  })

  // Non-managed branch keeps its own knob separate from the managed ones.
  await withEnv({ CHAT2API_QWEN_AI_TRANSCRIPT_POINTER_PROMPT: 'PLAIN-CUSTOM-POINTER-5c1d' }, async () => {
    const uploader = createStubUploader()
    const prepared = await prepareQwenAiMultimodalMessage(
      [{ role: 'user', content: `PLAIN_CORPUS:${'y'.repeat(120_000)}` }],
      uploader as never,
      { transport: 'document', requestMaxBytes: 90 * 1024 },
    )
    assert.equal(prepared.transport, 'document')
    assert.match(prepared.content, /PLAIN-CUSTOM-POINTER-5c1d/)
    assert.ok(!prepared.content.includes(TAIL_OPEN), 'non-managed branch never gains a tail')
  })
})

test('complete-mode tail includes the final tool result on workflow-continuation shapes', async () => {
  await withEnv({ CHAT2API_QWEN_AI_DOCUMENT_INLINE_TAIL_BYTES: undefined }, async () => {
    const uploader = createStubUploader()
    const messages: ChatMessage[] = [
      { role: 'user', content: `CONTINUATION_CORPUS:${'z'.repeat(200_000)}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'FINAL_TOOL_RESULT_SENTINEL_8e07: file body here' },
    ]
    const prepared = await prepareQwenAiMultimodalMessage(
      messages,
      uploader as never,
      {
        transport: 'document',
        managedToolCalling: true,
        workflowContinuation: true,
        requestMaxBytes: 90 * 1024,
      },
    )
    const tailMatch = prepared.content.split(TAIL_OPEN)[1]?.split(TAIL_CLOSE)[0] ?? ''
    assert.match(tailMatch, /FINAL_TOOL_RESULT_SENTINEL_8e07/, 'the last tool result must ride the tail')
    const archived = uploader.uploadedTexts.join('\n')
    assert.match(archived, /CONTINUATION_CORPUS/)
    assert.match(archived, /FINAL_TOOL_RESULT_SENTINEL_8e07/)
  })
})
