import assert from 'node:assert/strict'
import test from 'node:test'
import { zaiTranscriptTail } from '../../src/main/proxy/adapters/zaiTranscript.ts'

const KB = 1024

/** Builds a transcript whose maxBytes cut lands inside the given marker,
 *  with more transcript lines after the marker so a line boundary exists. */
function transcriptWithCutInside(marker: string, fillerBytes: number): { transcript: string; maxBytes: number } {
  const filler = ('x'.repeat(120) + '\n').repeat(Math.ceil(fillerBytes / 121))
  const transcript = `${filler}\nassistant: <|CHAT2API|invoke name="exec_command"><|CHAT2API|parameter name="cmd"><![CDATA[run command]]>${marker}\nuser: Tool execution result data (already executed by the client): {"status":"success"}\nassistant: Done.`
  const total = Buffer.byteLength(transcript, 'utf8')
  // Cut so the excerpt window starts mid-marker.
  const markerOffset = transcript.indexOf(marker)
  const cutStart = markerOffset + 2
  return { transcript, maxBytes: total - cutStart }
}

test('transcript tail never starts inside a marker token', () => {
  const { transcript, maxBytes } = transcriptWithCutInside('</|CHAT2API|parameter>', 40 * KB)
  const excerpt = zaiTranscriptTail(transcript, maxBytes)
  assert.ok(excerpt.length > 0)
  assert.ok(!excerpt.startsWith('<'), 'excerpt must not begin with a partial marker fragment')
  assert.ok(excerpt.startsWith('user: '), 'excerpt must start at a record line boundary')
})

test('transcript tail cut inside a CDATA opener resumes at the next line', () => {
  const filler = ('y'.repeat(200) + '\n').repeat(100)
  const transcript = `${filler}user: <|CHAT2API|parameter name="cmd"><![CDATA[echo hello]]>\nassistant: output: hello\nuser: follow-up question`
  const openerOffset = transcript.indexOf('<![CDATA[')
  const maxBytes = Buffer.byteLength(transcript, 'utf8') - (openerOffset + 1)
  const excerpt = zaiTranscriptTail(transcript, maxBytes)
  assert.ok(!excerpt.startsWith('CDATA['), 'excerpt must not begin with a marker fragment')
  assert.ok(excerpt.startsWith('assistant: '), 'excerpt must resume at the next line boundary')
  assert.ok(excerpt.includes('follow-up question'), 'lines after the boundary must survive')
})

test('transcript tail never splits a multi-byte code point', () => {
  const filler = ('核'.repeat(100) + '\n').repeat(50)
  const transcript = `${filler}user: 完成任务`
  const maxBytes = Buffer.byteLength(transcript, 'utf8') - 5
  const excerpt = zaiTranscriptTail(transcript, maxBytes)
  assert.ok(!excerpt.startsWith('�'), 'excerpt must not begin with a replacement character')
})

test('transcript smaller than the cap is returned whole', () => {
  const transcript = 'user: hello\nassistant: hi'
  assert.equal(zaiTranscriptTail(transcript, 10 * KB), transcript)
})

test('single-line transcript keeps the raw byte tail as a fallback', () => {
  const transcript = 'a'.repeat(500)
  const excerpt = zaiTranscriptTail(transcript, 100)
  assert.equal(excerpt, 'a'.repeat(100))
})
