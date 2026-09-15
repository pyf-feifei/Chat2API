/**
 * Pure helpers for the Z.ai offloaded-transcript tail excerpt.
 *
 * Kept dependency-free so the excerpt boundary rules stay unit-testable
 * outside the adapter's bundled import graph.
 */

/**
 * Inline tail of a transcript archived as an uploaded document. The excerpt
 * must never start mid-line: the transcript carries managed-tool markers, and
 * a raw byte cut can split a marker token into malformed fragments (or split
 * a UTF-8 code point), which the model would then read and imitate. Resume at
 * the next line boundary instead; a line boundary can only fall inside free
 * text, where truncation is the intent.
 */
export function zaiTranscriptTail(transcript: string, maxBytes: number): string {
  const buf = Buffer.from(transcript, 'utf8')
  if (buf.byteLength <= maxBytes) return transcript
  const tail = buf.subarray(buf.byteLength - maxBytes).toString('utf8')
  const newline = tail.indexOf('\n')
  return newline === -1 ? tail : tail.slice(newline + 1)
}
