/**
 * `retrieve_tool_output` — recoverable compression, the retrieval half of CCR.
 *
 * When balanced mode omits a span, the span is archived and the request carries
 * a content-addressed marker. This module owns the other half: the tool the
 * model calls to get that span back, and the rules for resolving it.
 *
 * The tool is a PROXY-INTERNAL tool. The client never declared it, it is never
 * forwarded to the upstream provider in `request.tools`, and a call to it is
 * never surfaced to the client as an ordinary tool call. The proxy resolves it
 * from the local archive and continues the turn.
 *
 * Design: `docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`
 * Task 2.3.
 */

import type { CompressionArchive } from './compressionArchive.ts'
import type { NormalizedToolDefinition } from '../toolCalling/types.ts'
import type { NormalizedToolCall, NormalizedToolResult } from '../toolCalling/types.ts'

export const RETRIEVE_TOOL_NAME = 'retrieve_tool_output'

export const DEFAULT_MAX_RETRIEVALS_PER_REQUEST = 4

export type RetrievalSettings = {
  /** `CHAT2API_COMPRESS_RETRIEVAL`: off | on. */
  enabled: boolean
  maxRetrievalsPerRequest: number
}

/** Marker the balanced-mode rewrite writes into the request. */
const ARCHIVE_MARKER_PATTERN = /\[Chat2API archive:tool:([0-9a-f]{16})\b[^\]]*\]/g

/**
 * The tool definition handed to the managed tool plan.
 *
 * It is a real declaration so the prompt teaches the model the name and the
 * argument shape. It is NOT forwarded upstream; the adapter strips it, and
 * `isRetrievalToolName` is what the response path matches on.
 */
export function buildRetrieveTool(): NormalizedToolDefinition {
  return {
    name: RETRIEVE_TOOL_NAME,
    description: [
      'Retrieve a span of tool output that was omitted from the conversation history',
      'to save context. The omission marker names the hash. Call this with that hash',
      'to get the omitted lines back verbatim.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        hash: {
          type: 'string',
          description: 'The 16-character hash from a [Chat2API archive:tool:<hash>] marker.',
        },
      },
      required: ['hash'],
      additionalProperties: false,
    },
  } as NormalizedToolDefinition
}

export function isRetrievalToolName(name: string | undefined | null): boolean {
  return name === RETRIEVE_TOOL_NAME
}

/**
 * Strip the retrieval tool before the request goes to the provider.
 *
 * The upstream provider must never see a tool it cannot execute, and must never
 * see one whose only implementation is in this process. Returns a new array;
 * never mutates the input.
 */
export function stripRetrievalTool(
  tools: readonly NormalizedToolDefinition[] | undefined,
): NormalizedToolDefinition[] | undefined {
  if (!Array.isArray(tools)) return tools
  const filtered = tools.filter((tool) => !isRetrievalToolName(tool?.name))
  return filtered.length === tools.length ? tools as NormalizedToolDefinition[] : filtered
}

/** Whether this request should be taught about the retrieval tool at all. */
export function shouldInjectRetrievalTool(
  archivedCount: number,
  settings: RetrievalSettings,
): boolean {
  if (!settings.enabled) return false
  if (!Number.isSafeInteger(archivedCount) || archivedCount <= 0) return false
  return true
}

/** The hashes this request advertised, in order of appearance. */
export function extractArchiveHashes(messages: readonly { content?: unknown }[]): string[] {
  const hashes: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const content = message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
          .map((part) => (part as { text?: string }).text || '')
          .join('\n')
        : ''
    if (!text.includes('[Chat2API archive:tool:')) continue
    for (const match of text.matchAll(ARCHIVE_MARKER_PATTERN)) {
      const hash = match[1]
      if (seen.has(hash)) continue
      seen.add(hash)
      hashes.push(hash)
    }
  }
  return hashes
}

export interface RetrievalResolution {
  /** A normal tool result. Never an exception, never a crash. */
  result: NormalizedToolResult
  /** Whether the call was ours. `false` means hand it to the client untouched. */
  handled: boolean
}

function toolResult(call: NormalizedToolCall, content: string, isError: boolean): NormalizedToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    content,
    isError,
  } as NormalizedToolResult
}

/**
 * Resolve a retrieval call locally, or report that it is not ours.
 *
 * Every failure mode is a normal tool result carrying an error, because the
 * alternative is a turn that dies on a recoverable mistake. An unknown hash, a
 * malformed argument, a hash this request never advertised, and an exhausted
 * retrieval budget all resolve to an explanatory error result.
 */
export function resolveRetrievalCall(input: {
  call: NormalizedToolCall
  archive: CompressionArchive
  scope: string
  /** Hashes this request advertised. A call for anything else is rejected. */
  advertised: readonly string[]
  retrievalsUsed: number
  settings: RetrievalSettings
}): RetrievalResolution {
  const { call, archive, scope, advertised, retrievalsUsed, settings } = input

  if (!isRetrievalToolName(call.name)) {
    return { handled: false, result: toolResult(call, '', false) }
  }
  if (!settings.enabled) {
    return {
      handled: true,
      result: toolResult(
        call,
        'Retrieval is disabled for this request. The omitted span is not available.',
        true,
      ),
    }
  }

  const budget = Number.isSafeInteger(settings.maxRetrievalsPerRequest)
    && settings.maxRetrievalsPerRequest > 0
    ? settings.maxRetrievalsPerRequest
    : DEFAULT_MAX_RETRIEVALS_PER_REQUEST
  if (retrievalsUsed >= budget) {
    // A retrieve loop must not be able to spend the whole context budget
    // re-expanding spans. Exhaustion is a normal, explained outcome.
    return {
      handled: true,
      result: toolResult(
        call,
        `Retrieval budget of ${budget} call(s) for this request is exhausted. `
          + 'Proceed with the spans already available in the conversation.',
        true,
      ),
    }
  }

  let hash: string | undefined
  try {
    const parsed = JSON.parse(call.arguments || '{}') as { hash?: unknown }
    if (typeof parsed.hash === 'string') hash = parsed.hash.trim()
  } catch {
    // Fall through to the malformed-argument result below.
  }

  if (!hash || !/^[0-9a-f]{16}$/.test(hash)) {
    return {
      handled: true,
      result: toolResult(
        call,
        `Malformed retrieve_tool_output call: expected { "hash": "<16 hex chars>" }, `
          + `received ${JSON.stringify(call.arguments || '').slice(0, 120)}.`,
        true,
      ),
    }
  }

  if (!advertised.includes(hash)) {
    // A hash this request never advertised cannot have been produced by the
    // marker rewrite, so it is either a hallucination or a cross-request
    // attempt. Both are refused before the archive is consulted.
    return {
      handled: true,
      result: toolResult(
        call,
        `No omitted span in this conversation has hash ${hash}. `
          + 'Only hashes from a [Chat2API archive:tool:<hash>] marker in this request are retrievable.',
        true,
      ),
    }
  }

  const text = archive.resolve(scope, hash)
  if (text === undefined) {
    return {
      handled: true,
      result: toolResult(
        call,
        `Span ${hash} is no longer available. It was omitted from the history and has `
          + 'since expired or been evicted from the archive.',
        true,
      ),
    }
  }

  return { handled: true, result: toolResult(call, text, false) }
}
