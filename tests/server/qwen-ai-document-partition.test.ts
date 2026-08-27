import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareQwenAiMultimodalMessage } from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const SYSTEM_MARKER = 'CLIENT_SYSTEM_PROMPT_NEVER_ARCHIVE_7f3a'
const HISTORY_MARKER = 'ARCHIVED_HISTORY_TURN_MARKER_91cd'
const ACTIVE_MARKER = 'ACTIVE_USER_QUESTION_MARKER_5be2'

function buildMessages(systemText: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemText }]
  // Enough archived turns that the hybrid partition has something to archive
  // even at generous byte budgets.
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: 'user', content: `${HISTORY_MARKER} turn ${index}: please continue` })
    messages.push({ role: 'assistant', content: `${HISTORY_MARKER} reply ${index}: done` })
  }
  messages.push({ role: 'user', content: `${ACTIVE_MARKER} final question` })
  return messages
}

function createStubUploader() {
  const uploadedTexts: string[] = []
  const uploadedOptions: Array<{ includeEvidence?: boolean }> = []
  return {
    uploadedTexts,
    uploadedOptions,
    uploadPart: async (part: unknown, evidenceQueryText: string, options: { includeEvidence?: boolean } = {}) => {
      const source = JSON.stringify(part)
      const match = /data:text\/plain;base64,([A-Za-z0-9+/=]+)/.exec(source)
      uploadedTexts.push(match ? Buffer.from(match[1], 'base64').toString('utf8') : source)
      uploadedOptions.push(options)
      return { file: { id: `stub-${uploadedTexts.length}` }, evidence: undefined }
    },
  }
}

function archivedText(uploader: { uploadedTexts: string[] }): string {
  return uploader.uploadedTexts.join('\n')
}

test('hybrid document mode keeps client system prompt inline', async () => {
  const uploader = createStubUploader()
  const prepared = await prepareQwenAiMultimodalMessage(
    buildMessages(`You are a coding agent.\n${SYSTEM_MARKER}: follow these rules exactly.`),
    uploader as never,
    {
      transport: 'document',
      managedToolCalling: true,
      requestMaxBytes: 2000,
    },
  )

  assert.equal(prepared.transport, 'document')
  assert.equal(prepared.managedDocumentMode, 'hybrid')
  assert.match(prepared.content, new RegExp(SYSTEM_MARKER))
  assert.match(prepared.content, new RegExp(ACTIVE_MARKER))

  const archived = archivedText(uploader)
  assert.match(archived, new RegExp(HISTORY_MARKER))
  assert.doesNotMatch(archived, new RegExp(SYSTEM_MARKER))
  assert.ok(
    uploader.uploadedOptions.every(option => option.includeEvidence === false),
    'document transport must not generate attachment evidence excerpts',
  )
})

test('complete document mode also keeps client system prompt inline', async () => {
  const uploader = createStubUploader()
  const prepared = await prepareQwenAiMultimodalMessage(
    buildMessages(`${SYSTEM_MARKER}: complete-mode rules.`),
    uploader as never,
    {
      transport: 'document',
      managedToolCalling: true,
      managedDocumentMode: 'complete',
      requestMaxBytes: 0,
    },
  )

  assert.equal(prepared.transport, 'document')
  assert.equal(prepared.managedDocumentMode, 'complete')
  assert.match(prepared.content, new RegExp(SYSTEM_MARKER))

  const archived = archivedText(uploader)
  assert.match(archived, new RegExp(HISTORY_MARKER))
  assert.doesNotMatch(archived, new RegExp(SYSTEM_MARKER))
  assert.ok(
    uploader.uploadedOptions.every(option => option.includeEvidence === false),
    'document transport must not generate attachment evidence excerpts',
  )
})

test('inline transport is unchanged when nothing offloads', async () => {
  const uploader = createStubUploader()
  const prepared = await prepareQwenAiMultimodalMessage(
    [
      { role: 'system', content: `${SYSTEM_MARKER}: small session.` },
      { role: 'user', content: `${ACTIVE_MARKER} hello` },
    ],
    uploader as never,
    {
      transport: 'inline',
      managedToolCalling: true,
      requestMaxBytes: 0,
    },
  )

  assert.equal(prepared.transport, 'inline')
  assert.match(prepared.content, new RegExp(SYSTEM_MARKER))
  assert.equal(uploader.uploadedTexts.length, 0)
})
