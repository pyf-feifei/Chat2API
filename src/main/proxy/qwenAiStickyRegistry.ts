import { randomUUID } from 'node:crypto'
import type { QwenAiSessionBinding } from './qwenAiSessionBridge'

/**
 * Tracks which account currently hosts which sticky conversation lineage, so
 * new lineages can prefer accounts with no (or the fewest) active sticky
 * sessions. In-memory only: a restart loses the map, which is safe — the
 * worst case is a new lineage picks a busy account once.
 *
 * Two indexing schemes coexist:
 *
 * 1. **Lineage key** — the root response id of a `store:true` Responses
 *    chain. Minted on the first request, carried on the binding.
 *
 * 2. **Chain key** — a content fingerprint (`instructions + head messages`)
 *    for `store:false` clients like codex that never send
 *    `previous_response_id`. The chain entry remembers the upstream chat and
 *    how much of the client transcript has already been pushed into it.
 */
export interface QwenAiStickyRegistryOptions {
  /** Idle lineages are released after this long without a request. */
  idleTtlMs?: number
  now?: () => number
}

interface StickyLineageEntry {
  lineageKey: string
  accountId: string
  providerId: string
  chatId: string
  turnCount: number
  approxBytes: number
  /** Number of in-flight requests on this lineage. */
  inFlight: number
  lastTouchedAt: number
}

/** Lease handle returned by claimByChainKey — release() frees the chain. */
export interface QwenAiStickyChainClaim {
  chainKey: string
  token: string
}

export interface StickyChainEntry {
  chainKey: string
  accountId: string
  providerId: string
  chatId: string
  parentId: string
  /** sha256 of canonical messages[0..lastSeenCount] — prefix integrity. */
  historyHash: string
  /** How many leading client messages already live in the upstream chat. */
  lastSeenCount: number
  /** Managed-tool protocol used when the chain was established. */
  toolProtocol?: string
  turnCount: number
  approxBytes: number
  /** Idempotent-append ticket for client retries of the same delta. */
  appendedTurn?: {
    deltaHash: string
    userFid?: string
    state: 'appending' | 'done'
  }
  inFlight: number
  lastTouchedAt: number
}

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export class QwenAiStickyRegistry {
  private entries = new Map<string, StickyLineageEntry>()
  private chains = new Map<string, StickyChainEntry>()
  private readonly idleTtlMs: number
  private readonly now: () => number

  constructor(options: QwenAiStickyRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.now = options.now ?? Date.now
  }

  // -------------------------------------------------------------------------
  // Lineage (store:true / prev_response_id path)
  // -------------------------------------------------------------------------

  /** Active lineages currently pinned to an account. */
  countForAccount(accountId: string): number {
    this.pruneExpired()
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.accountId === accountId) count += 1
    }
    for (const chain of this.chains.values()) {
      if (chain.accountId === accountId) count += 1
    }
    return count
  }

  /** Snapshot the entry, if the lineage is still live. */
  get(lineageKey: string): Readonly<StickyLineageEntry> | undefined {
    this.pruneExpired()
    return this.entries.get(lineageKey)
  }

  /**
   * Register a lineage against an account/chat. Called when a new upstream
   * chat is created for the lineage (first turn, migration, checkpoint).
   */
  register(
    lineageKey: string,
    binding: Pick<QwenAiSessionBinding, 'accountId' | 'providerId' | 'chatId'>,
    stats: { turnCount?: number; approxBytes?: number } = {},
  ): void {
    this.pruneExpired()
    const existing = this.entries.get(lineageKey)
    this.entries.set(lineageKey, {
      lineageKey,
      accountId: binding.accountId,
      providerId: binding.providerId,
      chatId: binding.chatId,
      turnCount: stats.turnCount ?? existing?.turnCount ?? 0,
      approxBytes: stats.approxBytes ?? existing?.approxBytes ?? 0,
      inFlight: existing?.inFlight ?? 0,
      lastTouchedAt: this.now(),
    })
  }

  /** Refresh the idle timer; returns false if the lineage is gone. */
  touch(lineageKey: string): boolean {
    const entry = this.entries.get(lineageKey)
    if (!entry) return false
    entry.lastTouchedAt = this.now()
    return true
  }

  /** Update chat pointer + counters after a successful turn or migration. */
  update(
    lineageKey: string,
    update: {
      accountId?: string
      providerId?: string
      chatId?: string
      turnCount?: number
      approxBytes?: number
    },
  ): void {
    const entry = this.entries.get(lineageKey)
    if (!entry) return
    if (update.accountId !== undefined) entry.accountId = update.accountId
    if (update.providerId !== undefined) entry.providerId = update.providerId
    if (update.chatId !== undefined) entry.chatId = update.chatId
    if (update.turnCount !== undefined) entry.turnCount = update.turnCount
    if (update.approxBytes !== undefined) entry.approxBytes = update.approxBytes
    entry.lastTouchedAt = this.now()
  }

  /** Mark one request in-flight on this lineage. Returns a release handle. */
  acquire(lineageKey: string): () => void {
    const entry = this.entries.get(lineageKey)
    if (!entry) return () => {}
    entry.inFlight += 1
    entry.lastTouchedAt = this.now()
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.entries.get(lineageKey)
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1)
        current.lastTouchedAt = this.now()
      }
    }
  }

  /** Drop the lineage (binding cleared, conversation evicted, etc.). */
  release(lineageKey: string): void {
    this.entries.delete(lineageKey)
  }

  // -------------------------------------------------------------------------
  // Chain (store:false / content-fingerprint path)
  // -------------------------------------------------------------------------

  /**
   * Claim a chain for appending. Returns the chain entry plus a lease that
   * must be released when the request settles — success or failure.
   *
   * `busy` means another request on the same chain is in flight; the caller
   * should let the client retry rather than racing the append.
   */
  claimByChainKey(chainKey: string):
    | { status: 'claimed'; entry: StickyChainEntry; claim: QwenAiStickyChainClaim }
    | { status: 'busy'; retryAfterMs: number }
    | { status: 'missing' } {
    this.pruneExpired()
    const entry = this.chains.get(chainKey)
    if (!entry) return { status: 'missing' }

    const now = this.now()
    if (entry.inFlight > 0) {
      return { status: 'busy', retryAfterMs: 1000 }
    }

    entry.inFlight += 1
    entry.lastTouchedAt = now
    return {
      status: 'claimed',
      entry,
      claim: { chainKey, token: randomUUID() },
    }
  }

  /** Convert a chain entry into the binding shape the forwarder expects. */
  chainToBinding(
    entry: StickyChainEntry,
    extras: Pick<QwenAiSessionBinding, 'requestedModel' | 'actualModel' | 'requestFingerprint'> & { toolProtocol?: string },
  ): QwenAiSessionBinding {
    return {
      providerId: entry.providerId,
      accountId: entry.accountId,
      chatId: entry.chatId,
      parentId: entry.parentId,
      requestedModel: extras.requestedModel,
      actualModel: extras.actualModel,
      requestFingerprint: extras.requestFingerprint,
      ...(entry.toolProtocol ? { toolProtocol: entry.toolProtocol } : {}),
      lineageKey: entry.chainKey,
      turnCount: entry.turnCount,
      approxBytes: entry.approxBytes,
      appendedTurn: entry.appendedTurn
        ? { prevResponseId: '', deltaHash: entry.appendedTurn.deltaHash, state: entry.appendedTurn.state }
        : undefined,
    }
  }

  /** Release the in-flight slot acquired by claimByChainKey. */
  releaseChainClaim(claim: QwenAiStickyChainClaim): void {
    const entry = this.chains.get(claim.chainKey)
    if (!entry) return
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    entry.lastTouchedAt = this.now()
  }

  /**
   * Register or replace a chain's upstream pointer. Called on first turn,
   * after a checkpoint replay, and after a cross-account migration.
   */
  registerChain(
    chainKey: string,
    fields: Pick<
      StickyChainEntry,
      'accountId' | 'providerId' | 'chatId' | 'parentId' | 'historyHash' | 'lastSeenCount'
    > & { toolProtocol?: string },
  ): void {
    this.pruneExpired()
    const existing = this.chains.get(chainKey)
    this.chains.set(chainKey, {
      chainKey,
      ...fields,
      turnCount: (existing?.turnCount ?? 0) + 1,
      approxBytes: existing?.approxBytes ?? 0,
      inFlight: existing?.inFlight ?? 0,
      lastTouchedAt: this.now(),
    })
  }

  /** Update the chain tail after a successful continuation. */
  updateChain(
    chainKey: string,
    update: Partial<Pick<
      StickyChainEntry,
      'parentId' | 'historyHash' | 'lastSeenCount' | 'turnCount' | 'approxBytes' | 'appendedTurn'
    >>,
  ): void {
    const entry = this.chains.get(chainKey)
    if (!entry) return
    Object.assign(entry, update)
    entry.lastTouchedAt = this.now()
  }

  /** Drop a chain (upstream rejection, history rewrite, eviction). */
  releaseChain(chainKey: string): void {
    this.chains.delete(chainKey)
  }

  clear(): void {
    this.entries.clear()
    this.chains.clear()
  }

  stats(): { lineages: number; chains: number; byAccount: Record<string, number> } {
    this.pruneExpired()
    const byAccount: Record<string, number> = {}
    for (const entry of this.entries.values()) {
      byAccount[entry.accountId] = (byAccount[entry.accountId] ?? 0) + 1
    }
    for (const chain of this.chains.values()) {
      byAccount[chain.accountId] = (byAccount[chain.accountId] ?? 0) + 1
    }
    return { lineages: this.entries.size, chains: this.chains.size, byAccount }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.inFlight > 0) continue
      if (entry.lastTouchedAt + this.idleTtlMs <= now) {
        this.entries.delete(key)
      }
    }
    for (const [key, chain] of this.chains) {
      if (chain.inFlight > 0) continue
      if (chain.lastTouchedAt + this.idleTtlMs <= now) {
        this.chains.delete(key)
      }
    }
  }
}

export const qwenAiStickyRegistry = new QwenAiStickyRegistry({
  idleTtlMs: positiveIntegerFromEnv(
    'CHAT2API_QWEN_AI_STICKY_IDLE_TTL_MS',
    DEFAULT_IDLE_TTL_MS,
  ),
})
