/**
 * Compression backend contract.
 *
 * A backend is a pure rewrite of ONE text block. It is not allowed to decide
 * anything:
 *
 *   - whether a block may be compressed (that is the live zone's job),
 *   - whether a protected line may be dropped (`protectedLines` are indices the
 *     decision layer already marked; the backend must not remove them),
 *   - anything structural. `role`, `tool_call_id`, `tool_calls` and tool
 *     arguments never reach a backend, because a backend only ever sees a
 *     string.
 *
 * Returning `undefined` means "I decline to rewrite this block", which is a
 * normal outcome and is how a backend declines text it does not understand.
 * Returning a longer string is a bug, and the decision layer discards it.
 */

export type CompressionBackendId = 'ts' | 'wasm' | 'python'

export type BlockKind = 'text' | 'json' | 'log' | 'code' | 'unknown'

export interface CompactBlockOptions {
  kind: BlockKind
  mode: 'safe' | 'balanced'
  maxChars: number
  /** The latest real user message, so a backend can do task-aware selection. */
  activeQuery: string
  /** Line indices the decision layer wants kept verbatim. */
  protectedLines: number[]
}

export interface CompactBlockResult {
  text: string
  omittedChars: number
  omittedLines: number
  /**
   * Line indices the backend preserved. Reported rather than assumed so the
   * decision layer can assert the protected ones survived.
   */
  retained: number[]
  backend: CompressionBackendId
  /** Only populated in balanced mode, and only when something was dropped. */
  omittedLinesText?: string[]
  /**
   * Which rules fired. These are reported metrics, not control flow: the
   * decision layer counts them into its result and the forwarder log, so a
   * backend that does not report them loses observability rather than
   * correctness.
   */
  compactedJson?: boolean
  compressedRunCount?: number
}

export interface CompressionBackend {
  readonly id: CompressionBackendId
  /**
   * Whether this backend can run here and now. Must not throw; a backend that
   * cannot load reports `false` and the registry falls through.
   */
  available(): Promise<boolean>
  compact(text: string, options: CompactBlockOptions): Promise<CompactBlockResult | undefined>
}
