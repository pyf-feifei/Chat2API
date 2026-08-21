import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ChatMessage, ChatMessageContent } from '../types'
import type { QwenAiSessionBinding } from '../qwenAiSessionBridge'

export interface ResponsesConversationStoreOptions {
  ttlMs?: number
  maxEntries?: number
  maxTotalBytes?: number
  maxEntryBytes?: number
  checkpointInterval?: number
  persistencePath?: string | 'auto' | false
  now?: () => number
}

export interface ResponsesConversationSetOptions {
  parentResponseId?: string
  deltaMessages?: ChatMessage[]
}

interface StoredConversation {
  messages: ChatMessage[]
  qwenAiSessionBinding?: QwenAiSessionBinding
  bytes: number
  expiresAt: number
  persistenceDepth: number
}

export interface StoredResponsesConversation {
  messages: ChatMessage[]
  qwenAiSessionBinding?: QwenAiSessionBinding
}

interface PersistedSetRecord {
  version: 1
  operation: 'set'
  responseId: string
  mode: 'checkpoint' | 'delta'
  parentResponseId?: string
  messages: ChatMessage[]
  qwenAiSessionBinding?: QwenAiSessionBinding
  expiresAt: number
  persistenceDepth: number
}

interface PersistedDeleteRecord {
  version: 1
  operation: 'delete'
  responseId: string
}

interface PersistedClearBindingRecord {
  version: 1
  operation: 'clear_binding'
  responseId: string
}

interface PersistedClearRecord {
  version: 1
  operation: 'clear'
}

type PersistedRecord = PersistedSetRecord
  | PersistedDeleteRecord
  | PersistedClearBindingRecord
  | PersistedClearRecord

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024
const DEFAULT_CHECKPOINT_INTERVAL = 32
const MIN_PERSISTENCE_REWRITE_BYTES = 4 * 1024 * 1024

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function cloneContent(content: ChatMessage['content']): ChatMessage['content'] {
  if (!Array.isArray(content)) return content
  return content.map((part): ChatMessageContent => ({
    ...part,
    image_url: part.image_url ? { ...part.image_url } : undefined,
    file_url: part.file_url ? { ...part.file_url } : undefined,
    input_audio: part.input_audio ? { ...part.input_audio } : undefined,
    video_url: part.video_url ? { ...part.video_url } : undefined,
  }))
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: cloneContent(message.content),
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: { ...toolCall.function },
          })),
        }
      : {}),
  }))
}

function cloneQwenAiSessionBinding(
  binding: QwenAiSessionBinding | undefined,
): QwenAiSessionBinding | undefined {
  return binding ? { ...binding } : undefined
}

function estimateConversationBytes(
  messages: ChatMessage[],
  qwenAiSessionBinding: QwenAiSessionBinding | undefined,
): number {
  return Buffer.byteLength(JSON.stringify({ messages, qwenAiSessionBinding }), 'utf8')
}

function defaultPersistencePath(): string | undefined {
  const configured = process.env.CHAT2API_RESPONSES_STORE_PATH?.trim()
  if (configured && !/^(?:off|false|disabled)$/i.test(configured)) return resolve(configured)
  if (configured) return undefined
  const dataDir = process.env.CHAT2API_DATA_DIR
    ? resolve(process.env.CHAT2API_DATA_DIR)
    : process.env.NODE_ENV === 'production'
      ? '/data'
      : join(homedir(), '.chat2api')
  return join(dataDir, 'responses', 'conversations.jsonl')
}

function isPersistedRecord(value: unknown): value is PersistedRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PersistedRecord>
  return record.version === 1
    && typeof record.operation === 'string'
    && ['set', 'delete', 'clear_binding', 'clear'].includes(record.operation)
}

export class ResponsesConversationStore {
  private entries = new Map<string, StoredConversation>()
  private totalBytes = 0
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxTotalBytes: number
  private readonly maxEntryBytes: number
  private readonly checkpointInterval: number
  private readonly configuredPersistencePath: string | 'auto' | false | undefined
  private readonly now: () => number
  private persistenceInitialized = false
  private persistencePath?: string
  private persistenceBytes = 0
  private rewritingPersistence = false

  constructor(options: ResponsesConversationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.checkpointInterval = options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL
    this.configuredPersistencePath = options.persistencePath
    this.now = options.now ?? Date.now
  }

  get(responseId: string): ChatMessage[] | undefined {
    return this.getConversation(responseId)?.messages
  }

  getConversation(responseId: string): StoredResponsesConversation | undefined {
    this.ensurePersistenceInitialized()
    this.pruneExpired()
    const entry = this.entries.get(responseId)
    if (!entry) return undefined

    // Refresh insertion order for LRU eviction without mutating the value.
    this.entries = new Map<string, StoredConversation>([
      ...Array.from(this.entries.entries()).filter(([id]) => id !== responseId),
      [responseId, entry],
    ])
    return {
      messages: cloneMessages(entry.messages),
      qwenAiSessionBinding: cloneQwenAiSessionBinding(entry.qwenAiSessionBinding),
    }
  }

  set(
    responseId: string,
    messages: ChatMessage[],
    qwenAiSessionBinding?: QwenAiSessionBinding,
    options: ResponsesConversationSetOptions = {},
  ): boolean {
    this.ensurePersistenceInitialized()
    this.pruneExpired()
    const cloned = cloneMessages(messages)
    const clonedBinding = cloneQwenAiSessionBinding(qwenAiSessionBinding)
    const bytes = estimateConversationBytes(cloned, clonedBinding)
    if (bytes > this.maxEntryBytes || bytes > this.maxTotalBytes) return false

    const parent = options.parentResponseId
      ? this.entries.get(options.parentResponseId)
      : undefined
    const canPersistDelta = Boolean(
      parent
      && options.deltaMessages
      && cloned.length === parent!.messages.length + options.deltaMessages.length,
    )
    const nextDepth = canPersistDelta ? parent!.persistenceDepth + 1 : 0
    const expiresAt = this.now() + this.ttlMs

    this.removeEntry(responseId, false)
    while (
      this.entries.size >= this.maxEntries
      || (this.totalBytes + bytes > this.maxTotalBytes && this.entries.size > 0)
    ) {
      const oldest = this.entries.entries().next().value as [string, StoredConversation] | undefined
      if (!oldest) break
      this.removeEntry(oldest[0], true)
    }

    // An eviction can remove the parent selected above. Persist this response
    // independently in that case so restart recovery never depends on a
    // lineage record that is no longer retained.
    const persistAsDelta = canPersistDelta
      && nextDepth < this.checkpointInterval
      && Boolean(options.parentResponseId && this.entries.has(options.parentResponseId))
    const useCheckpoint = !persistAsDelta
    const persistenceDepth = persistAsDelta ? nextDepth : 0

    const entry: StoredConversation = {
      messages: cloned,
      ...(clonedBinding ? { qwenAiSessionBinding: clonedBinding } : {}),
      bytes,
      expiresAt,
      persistenceDepth,
    }
    this.entries = new Map<string, StoredConversation>([
      ...Array.from(this.entries.entries()),
      [responseId, entry],
    ])
    this.totalBytes += bytes

    const persistedMessages = useCheckpoint
      ? cloned
      : cloneMessages(options.deltaMessages ?? [])
    this.appendRecord({
      version: 1,
      operation: 'set',
      responseId,
      mode: useCheckpoint ? 'checkpoint' : 'delta',
      ...(!useCheckpoint && options.parentResponseId
        ? { parentResponseId: options.parentResponseId }
        : {}),
      messages: persistedMessages,
      ...(clonedBinding ? { qwenAiSessionBinding: clonedBinding } : {}),
      expiresAt,
      persistenceDepth,
    })
    return true
  }

  delete(responseId: string): void {
    this.ensurePersistenceInitialized()
    this.removeEntry(responseId, true)
  }

  clearQwenAiSessionBinding(responseId: string): void {
    this.ensurePersistenceInitialized()
    const entry = this.entries.get(responseId)
    if (!entry?.qwenAiSessionBinding) return

    const nextEntry: StoredConversation = {
      messages: entry.messages,
      bytes: estimateConversationBytes(entry.messages, undefined),
      expiresAt: entry.expiresAt,
      persistenceDepth: entry.persistenceDepth,
    }
    this.entries = new Map([
      ...Array.from(this.entries.entries()).filter(([id]) => id !== responseId),
      [responseId, nextEntry],
    ])
    this.totalBytes += nextEntry.bytes - entry.bytes
    this.appendRecord({ version: 1, operation: 'clear_binding', responseId })
  }

  clear(): void {
    this.ensurePersistenceInitialized()
    this.entries = new Map()
    this.totalBytes = 0
    this.appendRecord({ version: 1, operation: 'clear' })
  }

  stats(): { entries: number; totalBytes: number } {
    this.ensurePersistenceInitialized()
    this.pruneExpired()
    return { entries: this.entries.size, totalBytes: this.totalBytes }
  }

  private ensurePersistenceInitialized(): void {
    if (this.persistenceInitialized) return
    this.persistenceInitialized = true
    if (this.configuredPersistencePath === false || this.configuredPersistencePath === undefined) {
      return
    }

    this.persistencePath = this.configuredPersistencePath === 'auto'
      ? defaultPersistencePath()
      : resolve(this.configuredPersistencePath)
    if (!this.persistencePath) return

    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      if (!existsSync(this.persistencePath)) return
      const content = readFileSync(this.persistencePath, 'utf8')
      this.persistenceBytes = Buffer.byteLength(content, 'utf8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as unknown
          if (isPersistedRecord(record)) this.applyRecord(record)
        } catch (error) {
          console.warn('[Responses] Ignored malformed persisted conversation record', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      this.pruneExpired(false)
      this.enforceBounds(false)
    } catch (error) {
      console.error('[Responses] Failed to restore persisted conversations', {
        path: this.persistencePath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private applyRecord(record: PersistedRecord): void {
    if (record.operation === 'clear') {
      this.entries = new Map()
      this.totalBytes = 0
      return
    }
    if (record.operation === 'delete') {
      this.removeEntry(record.responseId, false)
      return
    }
    if (record.operation === 'clear_binding') {
      const entry = this.entries.get(record.responseId)
      if (!entry) return
      const nextEntry: StoredConversation = {
        messages: entry.messages,
        bytes: estimateConversationBytes(entry.messages, undefined),
        expiresAt: entry.expiresAt,
        persistenceDepth: entry.persistenceDepth,
      }
      this.entries = new Map([
        ...Array.from(this.entries.entries()).filter(([id]) => id !== record.responseId),
        [record.responseId, nextEntry],
      ])
      this.totalBytes += nextEntry.bytes - entry.bytes
      return
    }

    const parent = record.mode === 'delta' && record.parentResponseId
      ? this.entries.get(record.parentResponseId)
      : undefined
    if (record.mode === 'delta' && !parent) return
    const messages = record.mode === 'delta'
      ? [...cloneMessages(parent!.messages), ...cloneMessages(record.messages)]
      : cloneMessages(record.messages)
    const binding = cloneQwenAiSessionBinding(record.qwenAiSessionBinding)
    const bytes = estimateConversationBytes(messages, binding)
    if (bytes > this.maxEntryBytes || bytes > this.maxTotalBytes) return

    this.removeEntry(record.responseId, false)
    const entry: StoredConversation = {
      messages,
      ...(binding ? { qwenAiSessionBinding: binding } : {}),
      bytes,
      expiresAt: record.expiresAt,
      persistenceDepth: record.persistenceDepth,
    }
    this.entries = new Map([
      ...Array.from(this.entries.entries()),
      [record.responseId, entry],
    ])
    this.totalBytes += bytes
  }

  private appendRecord(record: PersistedRecord): void {
    if (!this.persistencePath || this.rewritingPersistence) return
    try {
      const line = `${JSON.stringify(record)}\n`
      appendFileSync(this.persistencePath, line, 'utf8')
      this.persistenceBytes += Buffer.byteLength(line, 'utf8')
      const rewriteThreshold = Math.max(
        MIN_PERSISTENCE_REWRITE_BYTES,
        this.maxTotalBytes * 2,
      )
      if (this.persistenceBytes > rewriteThreshold) this.rewritePersistence()
    } catch (error) {
      console.error('[Responses] Failed to persist conversation state', {
        path: this.persistencePath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private rewritePersistence(): void {
    if (!this.persistencePath || this.rewritingPersistence) return
    this.rewritingPersistence = true
    const temporaryPath = `${this.persistencePath}.${process.pid}.tmp`
    try {
      const lines = Array.from(this.entries.entries()).map(([responseId, entry]) => JSON.stringify({
        version: 1,
        operation: 'set',
        responseId,
        mode: 'checkpoint',
        messages: entry.messages,
        ...(entry.qwenAiSessionBinding
          ? { qwenAiSessionBinding: entry.qwenAiSessionBinding }
          : {}),
        expiresAt: entry.expiresAt,
        persistenceDepth: 0,
      } satisfies PersistedSetRecord))
      const content = lines.length > 0 ? `${lines.join('\n')}\n` : ''
      writeFileSync(temporaryPath, content, 'utf8')
      renameSync(temporaryPath, this.persistencePath)
      this.persistenceBytes = Buffer.byteLength(content, 'utf8')
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      console.error('[Responses] Failed to compact persisted conversations', {
        path: this.persistencePath,
        error: error instanceof Error ? error.message : String(error),
      })
      try {
        this.persistenceBytes = statSync(this.persistencePath).size
      } catch {
        this.persistenceBytes = 0
      }
    } finally {
      this.rewritingPersistence = false
    }
  }

  private removeEntry(responseId: string, persist: boolean): void {
    const entry = this.entries.get(responseId)
    if (!entry) return
    this.entries = new Map(Array.from(this.entries.entries()).filter(([id]) => id !== responseId))
    this.totalBytes -= entry.bytes
    // Active descendants can be delta-linked to the removed response. Rewrite
    // all survivors as checkpoints rather than appending a tombstone that
    // would make those descendants unrestorable on the next process start.
    if (persist) this.rewritePersistence()
  }

  private enforceBounds(persist: boolean): void {
    while (
      this.entries.size > this.maxEntries
      || (this.totalBytes > this.maxTotalBytes && this.entries.size > 0)
    ) {
      const oldest = this.entries.entries().next().value as [string, StoredConversation] | undefined
      if (!oldest) break
      this.removeEntry(oldest[0], persist)
    }
  }

  private pruneExpired(persist = true): void {
    const now = this.now()
    const expiredIds = Array.from(this.entries.entries())
      .filter(([, entry]) => entry.expiresAt <= now)
      .map(([id]) => id)
    for (const id of expiredIds) this.removeEntry(id, persist)
  }
}

export const responsesConversationStore = new ResponsesConversationStore({
  ttlMs: positiveIntegerFromEnv('CHAT2API_RESPONSES_STORE_TTL_MS', DEFAULT_TTL_MS),
  maxEntries: positiveIntegerFromEnv('CHAT2API_RESPONSES_STORE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES),
  maxTotalBytes: positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_STORE_MAX_TOTAL_BYTES',
    DEFAULT_MAX_TOTAL_BYTES,
  ),
  maxEntryBytes: positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_STORE_MAX_ENTRY_BYTES',
    DEFAULT_MAX_ENTRY_BYTES,
  ),
  checkpointInterval: positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_STORE_CHECKPOINT_INTERVAL',
    DEFAULT_CHECKPOINT_INTERVAL,
  ),
  persistencePath: 'auto',
})
