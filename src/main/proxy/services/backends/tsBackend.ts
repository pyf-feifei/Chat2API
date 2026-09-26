/**
 * The reference TypeScript backend.
 *
 * This is the current `upstreamTokenOptimizer` compaction logic, moved verbatim
 * behind the backend contract. It is always available, carries no dependency,
 * and is what every other backend is measured against.
 *
 * If a rewrite here changes output, the freeze test in
 * `tests/proxy/compression/safe-regression.test.ts` is the thing that should
 * have gone red first.
 */

import type {
  CompactBlockOptions,
  CompactBlockResult,
  CompressionBackend,
  CompressionBackendId,
} from './types.ts'

const REPEATED_LINE_MARKER_PREFIX = '[Chat2API repeated identical line x'
const MIN_REPEAT_RUN = 3
const MIN_REPEAT_SAVING_CHARS = 32
const MAX_SAFE_JSON_COMPACTION_CHARS = 1_000_000

function isCriticalLine(line: string): boolean {
  const normalized = line.trim().toLowerCase()
  if (!normalized) return false
  return /(?:error|exception|traceback|warning|failed|failure|success|passed|exit|status|path|file|line|command|token|secret|password|authorization|http|\b[1-5]\d{2}\b)/.test(normalized)
}

function looksLikeCodeOrMarkup(text: string): boolean {
  return /```|<\/?(?:html|script|style|svg|!doctype)\b|<\?xml\b/i.test(text)
    || /(?:^|\n)\s*(?:import\s|from\s|def\s|class\s|function\s|public\s|private\s|protected\s|const\s|let\s|var\s|using\s|#include\s*<)/m.test(text)
}

function compactValidJson(text: string): string | undefined {
  if (text.length > MAX_SAFE_JSON_COMPACTION_CHARS) return undefined
  const trimmed = text.trim()
  if (!/^[\[{]/.test(trimmed)) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    const compacted = JSON.stringify(parsed)
    if (typeof compacted !== 'string' || compacted.length >= trimmed.length) {
      return undefined
    }
    return compacted
  } catch {
    return undefined
  }
}

function repeatedLineMarker(count: number): string {
  return `${REPEATED_LINE_MARKER_PREFIX}${count}]`
}

function compactRepeatedLines(text: string): { text: string; compressedRunCount: number } {
  const lines = text.split('\n')
  const output: string[] = []
  let compressedRunCount = 0
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    let end = index + 1
    while (end < lines.length && lines[end] === line) end += 1

    const runLength = end - index
    const isBlankLine = line.trim() === ''
    const canCompact = runLength >= MIN_REPEAT_RUN
      && (isBlankLine || (!isCriticalLine(line) && !looksLikeCodeOrMarkup(text)))
    if (!canCompact) {
      for (let offset = index; offset < end; offset += 1) output.push(lines[offset])
      index = end
      continue
    }

    const marker = repeatedLineMarker(runLength)
    const originalChars = line.length * runLength
    const compactChars = line.length + marker.length
    if (originalChars - compactChars < MIN_REPEAT_SAVING_CHARS) {
      for (let offset = index; offset < end; offset += 1) output.push(lines[offset])
    } else {
      output.push(line, marker)
      compressedRunCount += 1
    }
    index = end
  }

  return { text: output.join('\n'), compressedRunCount }
}

type ToolTextResult = {
  text: string
  compactedJson: boolean
  compressedRunCount: number
  retained: number[]
}

function compactToolText(text: string): ToolTextResult | undefined {
  if (text.length < 128) return undefined

  const compactedJson = compactValidJson(text)
  if (compactedJson) {
    return { text: compactedJson, compactedJson: true, compressedRunCount: 0, retained: [] }
  }

  if (text.includes(REPEATED_LINE_MARKER_PREFIX)) return undefined
  const repeated = compactRepeatedLines(text)
  if (repeated.compressedRunCount === 0) return undefined
  return { text: repeated.text, compactedJson: false, compressedRunCount: repeated.compressedRunCount, retained: [] }
}

function balancedOmittedMarker(omittedChars: number, omittedLines: number): string {
  return `[Chat2API omitted tool output: ${omittedChars} chars / ${omittedLines} lines; critical and query lines retained]`
}

type BalancedResult = {
  text: string
  omittedChars: number
  omittedLines: number
  omittedLinesText: string[]
  retained: number[]
}

function queryTerms(text: string): Set<string> {
  const terms = new Set<string>()
  const words = text.toLowerCase().split(/[^a-z0-9_㐀-鿿]+/i)
  for (const word of words) {
    if (word.length >= 3) terms.add(word)
    if (terms.size >= 64) break
  }
  for (const codePoint of text.toLowerCase()) {
    const value = codePoint.codePointAt(0) || 0
    if (value > 0x7f && terms.size < 128) terms.add(codePoint)
  }
  return terms
}

function lineMatchesQuery(line: string, terms: Set<string>): boolean {
  if (terms.size === 0) return false
  const normalized = line.toLowerCase()
  for (const term of terms) {
    if (normalized.includes(term)) return true
  }
  return false
}

function compactBalancedText(
  text: string,
  maxChars: number,
  activeQuery: string,
): BalancedResult | undefined {
  if (maxChars < 512 || text.length <= maxChars) return undefined

  const markerBudget = balancedOmittedMarker(0, 0).length + 32
  const payloadBudget = Math.max(256, maxChars - markerBudget)
  const lines = text.split('\n')
  const terms = queryTerms(activeQuery)
  const headCount = Math.max(1, Math.ceil(lines.length * 0.15))
  const tailCount = Math.max(1, Math.ceil(lines.length * 0.15))
  const selected = new Set<number>()
  const retained: number[] = []
  let selectedChars = 0

  const addIndex = (index: number): void => {
    if (selected.has(index) || index < 0 || index >= lines.length) return
    const nextChars = selectedChars + lines[index].length + 1
    if (nextChars > payloadBudget) return
    selected.add(index)
    retained.push(index)
    selectedChars = nextChars
  }

  // Critical and active-query lines get budget priority over ordinary head/tail
  // context. This is the task-aware part of balanced mode.
  for (let index = 0; index < lines.length; index += 1) {
    if (isCriticalLine(lines[index])) addIndex(index)
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (lineMatchesQuery(lines[index], terms)) addIndex(index)
  }
  for (let index = 0; index < headCount; index += 1) addIndex(index)
  for (let index = Math.max(0, lines.length - tailCount); index < lines.length; index += 1) {
    addIndex(index)
  }

  if (selected.size === 0 || Array.from(selected).some((index) => lines[index].length > payloadBudget)) {
    const headLength = Math.max(128, Math.floor(maxChars * 0.42))
    const tailLength = Math.max(128, Math.floor(maxChars * 0.42))
    if (headLength + tailLength >= text.length) return undefined
    const omittedChars = text.length - headLength - tailLength
    return {
      text: `${text.slice(0, headLength)}\n${balancedOmittedMarker(omittedChars, 1)}\n${text.slice(-tailLength)}`,
      omittedChars,
      omittedLines: 1,
      omittedLinesText: [text.slice(headLength, text.length - tailLength)],
      retained: [],
    }
  }

  const ordered = Array.from(selected).sort((left, right) => left - right)
  const output: string[] = []
  const omittedLinesText: string[] = []
  let previous = -1
  for (const index of ordered) {
    if (previous >= 0 && index > previous + 1) {
      let omittedChars = 0
      let omittedLines = 0
      for (let omitted = previous + 1; omitted < index; omitted += 1) {
        omittedChars += lines[omitted].length + 1
        omittedLines += 1
        omittedLinesText.push(lines[omitted])
      }
      output.push(balancedOmittedMarker(omittedChars, omittedLines))
    }
    output.push(lines[index])
    previous = index
  }
  if (previous < lines.length - 1) {
    let omittedChars = 0
    for (let omitted = previous + 1; omitted < lines.length; omitted += 1) {
      omittedChars += lines[omitted].length + 1
      omittedLinesText.push(lines[omitted])
    }
    output.push(balancedOmittedMarker(omittedChars, lines.length - previous - 1))
  }

  const compacted = output.join('\n')
  if (compacted.length >= text.length || compacted.length > maxChars) {
    const marker = balancedOmittedMarker(text.length, lines.length)
    const available = Math.max(256, maxChars - marker.length - 2)
    const headLength = Math.max(128, Math.floor(available * 0.5))
    const tailLength = Math.max(128, available - headLength)
    if (headLength + tailLength >= text.length) return undefined
    const omittedChars = text.length - headLength - tailLength
    return {
      text: `${text.slice(0, headLength)}\n${marker}\n${text.slice(-tailLength)}`,
      omittedChars,
      omittedLines: Math.max(1, lines.length - selected.size),
      omittedLinesText: [text.slice(headLength, text.length - tailLength)],
      retained: [],
    }
  }

  return {
    text: compacted,
    omittedChars: text.length - compacted.length,
    omittedLines: lines.length - selected.size,
    omittedLinesText,
    retained,
  }
}

const BACKEND_ID: CompressionBackendId = 'ts'

export const tsBackend: CompressionBackend = {
  id: BACKEND_ID,
  async available() {
    return true
  },
  async compact(text: string, options: CompactBlockOptions): Promise<CompactBlockResult | undefined> {
    try {
      if (options.mode === 'balanced') {
        const balanced = compactBalancedText(text, options.maxChars, options.activeQuery)
        if (balanced) {
          return {
            text: balanced.text,
            omittedChars: balanced.omittedChars,
            omittedLines: balanced.omittedLines,
            retained: balanced.retained,
            backend: BACKEND_ID,
            omittedLinesText: balanced.omittedLinesText,
          }
        }
      }
      const result = compactToolText(text)
      if (!result) return undefined
      return {
        text: result.text,
        omittedChars: 0,
        omittedLines: 0,
        retained: result.retained,
        backend: BACKEND_ID,
        compactedJson: result.compactedJson,
        compressedRunCount: result.compressedRunCount,
      }
    } catch {
      // A backend never fails the request. Returning undefined is "decline".
      return undefined
    }
  },
}
