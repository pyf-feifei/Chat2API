/**
 * Corpus fixture shape. See `fixtures.ts` (generated) and
 * `scripts/compress/extract-corpus.mjs`.
 *
 * The `flags` are not decorative. Each one names a branch in
 * `src/main/proxy/services/upstreamTokenOptimizer.ts`, so a regression points at
 * the rule that broke instead of at a string diff.
 */
export interface CompressionFixture {
  /**
   * Stable identifier, prefixed by the capture it came from:
   * `reqreal-*` (.testimg/req_real.json), `replay-*` (codex-replay-payload.json),
   * `session-*` (codex-session-*.md), `log-*` (dev-data/*.log),
   * `boundary-*` (synthetic).
   */
  name: string

  /** Redacted capture text. This is the only field the compressor ever sees. */
  text: string

  /** `text.length` before the 24k clip, which is what threshold branches use. */
  chars: number

  lines: number

  /** Mirror of `estimateTextTokens(text)`. */
  estimatedTokens: number

  /** Source file, or `'synthetic'`. Provenance only; never shown to a model. */
  source: string

  /**
   * A tool result whose content includes an inline base64 image part. These
   * cannot be compressed by the current optimizer at all — see the base64
   * finding in the design doc.
   */
  image?: boolean

  /** Content begins with `[` or `{`. */
  json?: boolean

  /** Contains a Python or Node stack trace. */
  trace?: boolean

  /** Contains real CJK text. Non-ASCII is charged one token per codepoint. */
  cjk?: boolean

  /** CJK bytes reinterpreted under the wrong codec. */
  mojibake?: boolean

  /** Contains a run of >= 3 identical non-blank lines. */
  repeated?: boolean

  /** Synthetic fixture pinned to a specific threshold boundary. */
  boundary?: string
}

/** Thresholds the corpus is deliberately built around. */
export const CORPUS_THRESHOLDS = {
  /** `compactToolText` returns undefined below this length. */
  compactToolTextFloor: 128,
  /** `MAX_TOOL_TEXT_CHARS` default; `balanced` skips at or below it. */
  balancedMaxChars: 16_000,
} as const
