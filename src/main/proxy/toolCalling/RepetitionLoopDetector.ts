/**
 * Streaming repetition-loop detector.
 *
 * Long-context preview models occasionally collapse into a degenerate
 * repetition loop: the same phrase (or a near-copy of it with counters
 * changed) repeats for tens of kilobytes. Healthy streams keep flowing, so
 * the idle watchdog never fires, and the answer is far too long for the
 * short-answer stall classifier — the loop streams to the client unchecked
 * (2026-09-13 17:14 incident: 365,537 chars / 25,605 SSE chunks).
 *
 * This detector watches the tail of the generated answer as deltas arrive
 * and reports the loop while it is still young (within the first ~1-2 KB of
 * junk) so the adapter can abort the upstream stream and route to the same
 * recovery path as the idle watchdog.
 *
 * Detection is structural, never content-based: no phrase blocklists, no
 * incident-specific signatures. Two scans run over the sliding window:
 *
 * 1. Exact period — the window tail ends with N consecutive copies of one
 *    period-p block (catches verbatim loops).
 * 2. Normalized period — same scan over a normalized copy of the window
 *    (lowercased, digits collapsed to '#', whitespace collapsed), so loops
 *    whose only variation is incrementing counters ("30s", "turn 12") are
 *    still caught.
 *
 * Guards against false positives:
 * - Minimum period length ignores short legitimate repeats (punctuation
 *   runs, spacing, table separators).
 * - Repeat thresholds sit well above what healthy prose or tables produce
 *   for blocks of this size.
 * - Checks run at most once per `checkIntervalChars` of growth, bounding
 *   CPU on token firehoses.
 */

export interface RepetitionLoopDetectorOptions {
  /** Sliding window of answer tail kept for analysis (chars). */
  windowChars: number
  /** Ignore repeat periods shorter than this (chars). */
  minPeriodChars: number
  /** Longest exact period considered (chars). */
  maxPeriodChars: number
  /** Consecutive raw repeats of one block that constitute a loop. */
  exactRepeatThreshold: number
  /** Consecutive normalized repeats of one block that constitute a loop. */
  normalizedRepeatThreshold: number
  /** Run scans at most once per this many chars of new input. */
  checkIntervalChars: number
}

export interface RepetitionLoopEvidence {
  kind: 'exact_period' | 'normalized_period'
  periodChars: number
  repeats: number
  /** One copy of the repeating block (normalized for normalized_period). */
  sample: string
}

const DEFAULT_OPTIONS: RepetitionLoopDetectorOptions = {
  windowChars: 4000,
  minPeriodChars: 24,
  maxPeriodChars: 300,
  exactRepeatThreshold: 8,
  normalizedRepeatThreshold: 10,
  checkIntervalChars: 512,
}

/**
 * A block only counts as a loop unit when it carries real content: enough
 * word-ish characters (letters or CJK). Punctuation runs, whitespace and
 * separators never qualify.
 */
function hasContent(block: string): boolean {
  const wordish = block.replace(/[^a-zA-Z0-9一-鿿㐀-䶿]/g, '')
  return wordish.length >= 3
}

function normalizeForLoopScan(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9０-９]+/g, '#')
    .replace(/\s+/g, ' ')
}

interface PeriodScanResult {
  periodChars: number
  repeats: number
  sample: string
}

/**
 * Count how many consecutive copies of the final period-p block end the
 * window, for each candidate p. Returns the longest match that meets the
 * threshold.
 */
function scanForPeriod(
  text: string,
  minPeriod: number,
  maxPeriod: number,
  threshold: number,
): PeriodScanResult | null {
  if (text.length < minPeriod * threshold) return null
  let best: PeriodScanResult | null = null
  for (let p = minPeriod; p <= maxPeriod; p += 1) {
    if (text.length < p * threshold) break
    const block = text.slice(text.length - p)
    if (!hasContent(block)) continue
    let repeats = 1
    let end = text.length - p
    while (repeats < threshold + 8 && end - p >= 0 && text.slice(end - p, end) === block) {
      repeats += 1
      end -= p
    }
    if (repeats >= threshold && (!best || p * repeats > best.periodChars * best.repeats)) {
      best = { periodChars: p, repeats, sample: block }
    }
  }
  return best
}

/** One-shot scan of a complete answer (non-stream path). */
export function detectRepetitionLoopInText(
  text: string,
  options: Partial<RepetitionLoopDetectorOptions> = {},
): RepetitionLoopEvidence | null {
  if (!text) return null
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const normalized = normalizeForLoopScan(text.slice(-opts.windowChars))
  const exact = scanForPeriod(text.slice(-opts.windowChars), opts.minPeriodChars, opts.maxPeriodChars, opts.exactRepeatThreshold)
  if (exact) {
    return { kind: 'exact_period', periodChars: exact.periodChars, repeats: exact.repeats, sample: exact.sample }
  }
  const normalizedHit = scanForPeriod(normalized, opts.minPeriodChars, opts.maxPeriodChars, opts.normalizedRepeatThreshold)
  if (normalizedHit) {
    return {
      kind: 'normalized_period',
      periodChars: normalizedHit.periodChars,
      repeats: normalizedHit.repeats,
      sample: normalizedHit.sample,
    }
  }
  return null
}

/** Incremental detector fed answer deltas as they stream. */
export class RepetitionLoopDetector {
  private readonly options: RepetitionLoopDetectorOptions
  private window = ''
  private charsSinceLastCheck = 0

  constructor(options: Partial<RepetitionLoopDetectorOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** Feed one answer delta. Returns evidence when a loop is detected. */
  push(delta: string): RepetitionLoopEvidence | null {
    if (!delta) return null
    this.window = (this.window + delta).slice(-this.options.windowChars)
    this.charsSinceLastCheck += delta.length
    if (this.charsSinceLastCheck < this.options.checkIntervalChars) return null
    this.charsSinceLastCheck = 0
    return detectRepetitionLoopInText(this.window, this.options)
  }

  /** Reset the window (used when a continuation replacement branch starts). */
  reset(): void {
    this.window = ''
    this.charsSinceLastCheck = 0
  }
}
