import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ResponsesConversationStore } from '../../src/main/proxy/responses/store.ts'
import type { QwenAiSessionBinding } from '../../src/main/proxy/qwenAiSessionBridge.ts'

const binding: QwenAiSessionBinding = {
  providerId: 'qwen-ai',
  accountId: 'account-1',
  requestedModel: 'qwen-test',
  actualModel: 'qwen-test-upstream',
  chatId: 'chat-1',
  parentId: 'parent-1',
  requestFingerprint: 'fingerprint-1',
}

test('Responses conversation persistence restores a delta lineage after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat2api-responses-store-'))
  const persistencePath = join(directory, 'conversations.jsonl')
  try {
    const first = new ResponsesConversationStore({
      persistencePath,
      checkpointInterval: 8,
      ttlMs: 60_000,
      now: () => 1_000,
    })
    const rootMessages = [{ role: 'user' as const, content: 'root' }]
    const deltaMessages = [
      { role: 'assistant' as const, content: 'answer' },
      { role: 'user' as const, content: 'follow-up' },
    ]
    assert.equal(first.set('resp_root', rootMessages), true)
    assert.equal(first.set(
      'resp_child',
      [...rootMessages, ...deltaMessages],
      binding,
      { parentResponseId: 'resp_root', deltaMessages },
    ), true)

    const records = readFileSync(persistencePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))
    assert.equal(records[0].mode, 'checkpoint')
    assert.equal(records[1].mode, 'delta')
    assert.equal(records[1].messages.length, deltaMessages.length)

    const restored = new ResponsesConversationStore({
      persistencePath,
      checkpointInterval: 8,
      ttlMs: 60_000,
      now: () => 1_001,
    })
    assert.deepEqual(restored.getConversation('resp_child'), {
      messages: [...rootMessages, ...deltaMessages],
      qwenAiSessionBinding: binding,
    })

    first.clearQwenAiSessionBinding('resp_child')
    const bindingCleared = new ResponsesConversationStore({
      persistencePath,
      ttlMs: 60_000,
      now: () => 1_002,
    })
    assert.equal(bindingCleared.getConversation('resp_child')?.qwenAiSessionBinding, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Responses persistence emits periodic full checkpoints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat2api-responses-checkpoint-'))
  const persistencePath = join(directory, 'conversations.jsonl')
  try {
    const store = new ResponsesConversationStore({
      persistencePath,
      checkpointInterval: 2,
      ttlMs: 60_000,
      now: () => 2_000,
    })
    const root = [{ role: 'user' as const, content: 'root' }]
    const one = [{ role: 'assistant' as const, content: 'one' }]
    const two = [{ role: 'user' as const, content: 'two' }]
    store.set('resp_0', root)
    store.set('resp_1', [...root, ...one], undefined, {
      parentResponseId: 'resp_0',
      deltaMessages: one,
    })
    store.set('resp_2', [...root, ...one, ...two], undefined, {
      parentResponseId: 'resp_1',
      deltaMessages: two,
    })

    const records = readFileSync(persistencePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))
    assert.deepEqual(records.map(record => record.mode), ['checkpoint', 'delta', 'checkpoint'])
    assert.equal(records[2].parentResponseId, undefined)
    assert.equal(records[2].messages.length, 3)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Responses persistence checkpoints a child when its parent is evicted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat2api-responses-eviction-'))
  const persistencePath = join(directory, 'conversations.jsonl')
  try {
    const store = new ResponsesConversationStore({
      persistencePath,
      maxEntries: 1,
      checkpointInterval: 8,
      ttlMs: 60_000,
      now: () => 3_000,
    })
    const root = [{ role: 'user' as const, content: 'root' }]
    const delta = [{ role: 'assistant' as const, content: 'answer' }]
    store.set('resp_root', root)
    store.set('resp_child', [...root, ...delta], undefined, {
      parentResponseId: 'resp_root',
      deltaMessages: delta,
    })

    const records = readFileSync(persistencePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))
    assert.equal(records.length, 1)
    assert.equal(records[0].responseId, 'resp_child')
    assert.equal(records[0].mode, 'checkpoint')

    const restored = new ResponsesConversationStore({
      persistencePath,
      maxEntries: 1,
      ttlMs: 60_000,
      now: () => 3_001,
    })
    assert.deepEqual(restored.get('resp_child'), [...root, ...delta])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Responses persistence restores 683 messages with 312 tool results', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat2api-responses-scale-'))
  const persistencePath = join(directory, 'conversations.jsonl')
  try {
    const messages = Array.from({ length: 312 }, (_, index) => [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: `call_scale_${index}`,
          type: 'function' as const,
          function: {
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: `Get-Content fixture-${index}.txt` }),
          },
        }],
      },
      {
        role: 'tool' as const,
        tool_call_id: `call_scale_${index}`,
        content: `fixture result ${index}`,
      },
    ]).flat()
    messages.push(...Array.from({ length: 59 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `development history ${index}`,
    })))

    const first = new ResponsesConversationStore({
      persistencePath,
      ttlMs: 60_000,
      now: () => 4_000,
    })
    assert.equal(messages.length, 683)
    assert.equal(messages.filter(message => message.role === 'tool').length, 312)
    assert.equal(first.set('resp_scale', messages), true)

    const restored = new ResponsesConversationStore({
      persistencePath,
      ttlMs: 60_000,
      now: () => 4_001,
    }).get('resp_scale')
    assert.equal(restored?.length, 683)
    assert.equal(restored?.filter(message => message.role === 'tool').length, 312)
    assert.deepEqual(restored, messages)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
