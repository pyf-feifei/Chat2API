/**
 * M365 Copilot session continuation tracker.
 *
 * API clients resend the full conversation on every request, but the consumer
 * Chathub wire (browser-verified 2026-08-28) continues a conversation by
 * reusing the SAME conversationId/sessionId on the WebSocket handshake URL
 * and sending ONLY the new user text with isStartOfSession=false — the
 * upstream associates context from the URL's ConversationId (it persists
 * conversations server-side). Replay-style transcripts would force a fresh
 * conversation per request and re-upload the whole history every turn.
 *
 * This module decides, per account, whether an incoming message list extends
 * the conversation we last served: if the stored turn sequence is a prefix
 * of the incoming one (by role+text), the request is a continuation and only
 * the new tail needs to be sent.
 */

export interface ContinuationTurn {
  role: string
  text: string
}

export interface ContinuationMatch {
  conversationId: string
  sessionId: string
  /** The user text(s) not yet sent upstream, role-labelled when multiple. */
  deltaText: string
  /** Number of stored turns the incoming history extends. */
  matchedTurnCount: number
}

interface StoredConversation {
  conversationId: string
  sessionId: string
  /** Turn sequence already sent and completed upstream. */
  turns: ContinuationTurn[]
  updatedAt: number
}

const MAX_STORED_CONVERSATIONS_PER_ACCOUNT = 4
const MAX_TURNS_TRACKED = 200
const STORE_TTL_MS = 24 * 60 * 60 * 1000

/** module-level store keyed by account id (adapters are per-request). */
const store = new Map<string, StoredConversation[]>()

function extractTurns(messages: unknown): ContinuationTurn[] {
  const turns: ContinuationTurn[] = []
  if (!Array.isArray(messages)) return turns
  for (const msg of messages as Array<{ role?: unknown; content?: unknown }>) {
    if (!msg || typeof msg.role !== 'string') continue
    if (msg.role === 'system' || msg.role === 'tool') continue
    let text = ''
    if (typeof msg.content === 'string') {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      const textPart = (msg.content as Array<{ type?: unknown; text?: unknown }>).find(
        (p) => p?.type === 'text' && typeof p.text === 'string',
      )
      if (textPart) text = textPart.text as string
    }
    if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
      // tool-calling transcripts take the managed path; never match here
      return []
    }
    if (!text) continue
    turns.push({ role: msg.role, text })
  }
  return turns
}

function turnsEqual(a: ContinuationTurn, b: ContinuationTurn): boolean {
  return a.role === b.role && a.text === b.text
}

function isPrefix(prefix: ContinuationTurn[], full: ContinuationTurn[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (!turnsEqual(prefix[i], full[i])) return false
  }
  return true
}

function deltaToText(delta: ContinuationTurn[]): string {
  if (delta.length === 1) return delta[0].text
  return delta.map((t) => `[${t.role}]\n${t.text}`).join('\n\n')
}

function prune(list: StoredConversation[], now: number): StoredConversation[] {
  const alive = list.filter((c) => now - c.updatedAt < STORE_TTL_MS)
  while (alive.length > MAX_STORED_CONVERSATIONS_PER_ACCOUNT) {
    // drop the least recently updated
    let oldest = 0
    for (let i = 1; i < alive.length; i++) {
      if (alive[i].updatedAt < alive[oldest].updatedAt) oldest = i
    }
    alive.splice(oldest, 1)
  }
  return alive
}

export const sessionContinuations = {
  /**
   * Returns a continuation payload when `messages` strictly extends a
   * conversation previously completed via `record()` on this account.
   * Single-message requests and non-extending histories return undefined
   * (callers fall back to the full-transcript path).
   */
  match(accountId: string, messages: unknown): ContinuationMatch | undefined {
    const list = store.get(accountId)
    if (!list || list.length === 0) return undefined
    const turns = extractTurns(messages)
    if (turns.length === 0) return undefined
    const now = Date.now()
    for (const conv of list) {
      if (now - conv.updatedAt >= STORE_TTL_MS) continue
      if (!isPrefix(conv.turns, turns)) continue
      const delta = turns.slice(conv.turns.length)
      if (delta.length === 0) continue
      // continuation must add at least one user turn so the upstream gets
      // something to answer
      if (!delta.some((t) => t.role === 'user')) continue
      return {
        conversationId: conv.conversationId,
        sessionId: conv.sessionId,
        deltaText: deltaToText(delta),
        matchedTurnCount: conv.turns.length,
      }
    }
    return undefined
  },

  /** Store/replace the conversation served for this account. */
  record(
    accountId: string,
    conversationId: string,
    sessionId: string,
    turns: ContinuationTurn[],
  ): void {
    if (!accountId || !conversationId || !sessionId || turns.length === 0) return
    const now = Date.now()
    let list = prune(store.get(accountId) || [], now)
    const existing = list.find((c) => c.conversationId === conversationId)
    const capped = turns.slice(-MAX_TURNS_TRACKED)
    if (existing) {
      existing.sessionId = sessionId
      existing.turns = capped
      existing.updatedAt = now
    } else {
      list.push({ conversationId, sessionId, turns: capped, updatedAt: now })
    }
    list = prune(list, now)
    store.set(accountId, list)
  },

  /** Drop any stored state (used when an account is removed/re-authed). */
  clear(accountId: string): void {
    store.delete(accountId)
  },

  /** Test/ops helper. */
  size(accountId: string): number {
    return store.get(accountId)?.length || 0
  },
}
