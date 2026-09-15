import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RepetitionLoopDetector,
  detectRepetitionLoopInText,
} from '../../src/main/proxy/toolCalling/RepetitionLoopDetector.ts'

const INCIDENT_UNIT = 'Write_stdin. Empty chars. 30s. 20k. Emitting. Just the tool call. Let me emit it. Session 58967. '

test('detects the verbatim incident loop (exact period)', () => {
  const text = INCIDENT_UNIT.repeat(12)
  const evidence = detectRepetitionLoopInText(text)
  assert.ok(evidence, 'expected loop evidence')
  assert.equal(evidence!.kind, 'exact_period')
  assert.ok(evidence!.repeats >= 8)
  assert.ok(evidence!.sample.includes('Write_stdin'))
})

test('detects a loop whose only variation is incrementing counters (normalized period)', () => {
  let text = ''
  for (let i = 0; i < 20; i += 1) {
    text += `Step ${i}: poll session 58967 and wait 30s for output chunks to arrive. `
  }
  const evidence = detectRepetitionLoopInText(text)
  assert.ok(evidence, 'expected loop evidence')
  assert.equal(evidence!.kind, 'normalized_period')
})

test('does not fire on healthy varied prose', () => {
  const prose = [
    'The import script patches each account row before submitting it to the upstream provider.',
    'After the patch, a syntax check runs so that a broken transform cannot reach the live test.',
    'Live testing starts with a single row so that the first failure surfaces immediately.',
    'When a row fails, the error is written back to the spreadsheet with its original row number.',
  ].join(' ')
  assert.equal(detectRepetitionLoopInText(prose), null)
})

test('does not fire when repeats stay below the threshold', () => {
  const text = 'The verification pipeline waits for the upstream confirmation before continuing. '.repeat(6)
  assert.equal(detectRepetitionLoopInText(text), null)
})

test('punctuation-only repetition never qualifies as a loop unit', () => {
  const text = '.'.repeat(4000)
  assert.equal(detectRepetitionLoopInText(text), null)
  assert.equal(detectRepetitionLoopInText('— '.repeat(2000)), null)
})

test('incremental push detects the loop as deltas stream in', () => {
  const detector = new RepetitionLoopDetector()
  let evidence = null
  for (let i = 0; i < 14 && !evidence; i += 1) {
    evidence = detector.push(INCIDENT_UNIT)
  }
  assert.ok(evidence, 'expected loop evidence from streamed deltas')
})

test('reset clears the window so a continuation branch starts clean', () => {
  const detector = new RepetitionLoopDetector()
  for (let i = 0; i < 12; i += 1) detector.push(INCIDENT_UNIT)
  detector.reset()
  assert.equal(detector.push('Normal recovery branch output continues here with varied content. '), null)
})

test('loop detection fires early, within the first couple of kilobytes of junk', () => {
  const detector = new RepetitionLoopDetector()
  let fed = 0
  let evidence = null
  for (let i = 0; i < 40 && !evidence; i += 1) {
    evidence = detector.push(INCIDENT_UNIT)
    fed += INCIDENT_UNIT.length
  }
  assert.ok(evidence, 'expected loop evidence')
  assert.ok(fed < 6000, `detector fired late after ${fed} chars`)
})
