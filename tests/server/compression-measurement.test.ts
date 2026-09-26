/**
 * Compression measurement and logging — Phase 6.
 *
 * The properties under test are about what an operator can see. A saving that is
 * not logged is not a saving, and a log line that carries tool content is a leak.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const forwarder = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
const loop = fs.readFileSync('src/main/proxy/services/retrievalLoop.ts', 'utf8')
const stream = fs.readFileSync('src/main/proxy/services/retrievalStream.ts', 'utf8')
const optimizer = fs.readFileSync('src/main/proxy/services/upstreamTokenOptimizer.ts', 'utf8')

test('the optimizer log reports the compute backend and the live zone', () => {
  for (const field of [
    'backend: optimization.backend',
    'liveZoneSource',
    'liveZoneFloor',
    'liveZoneCeiling',
    'archivedCount',
    'archivedChars',
  ]) {
    assert.ok(forwarder.includes(field), `the optimizer log should report ${field}`)
  }
})

test('the optimizer is always given a compression context', () => {
  // A real run logged `archivedCount: 0` in balanced mode because this call
  // passed no context, so `archiveOmission` declined every span. The archive is
  // what makes balanced mode recoverable, so it must not be conditional on the
  // retrieval loop being armed.
  assert.ok(
    forwarder.includes('optimizeUpstreamRequest(request, tokenOptimizerSettings, ccrContext)'),
    'the optimizer call must pass a compression context',
  )
  assert.ok(
    forwarder.includes('archive: this.compressionArchive()'),
    'the archive must be supplied on every request, not only an armed one',
  )
  assert.ok(forwarder.includes('private compressionArchive()'),
    'the archive accessor must exist so the store is created once, not per request')
})

test('createRetrievalToolContext receives the request id instead of closing over it', () => {
  // A real run failed every retrieval-armed request with
  // `context is not defined`: the method referenced a `context` that was not one
  // of its parameters. The proxy context is not in scope inside it.
  assert.match(
    forwarder,
    /createRetrievalToolContext\([\s\S]*?requestId\?: string,/,
    'the request id must be a declared parameter',
  )
  assert.doesNotMatch(
    forwarder.slice(
      forwarder.indexOf('private createRetrievalToolContext('),
      forwarder.indexOf('private compressionArchive()'),
    ),
    /context\.requestId/,
    'the method must not read a `context` it does not receive',
  )
  assert.ok(
    forwarder.includes('createRetrievalToolContext(modifiedRequest, account, provider, context.requestId)'),
    'the call site must pass the request id',
  )
})

test('the retrieval loop reports its turns, not just its output', () => {
  // The first version of the Phase C wiring took `.response` off the loop
  // result and threw the rest away, so a loop that spun to its budget was
  // indistinguishable from one that never fired.
  assert.ok(
    forwarder.includes('retrievalLoop.turns') && forwarder.includes('retrievalLoop.resolved.length'),
    'the loop result must be inspected, not only consumed for its response',
  )
  assert.match(forwarder, /\[Forwarder\] retrieval loop/,
    'the non-streaming loop must log')
  assert.match(forwarder, /\[Forwarder\] retrieval stream loop/,
    'the streaming loop must log')
})

test('every loop exit reason is reported', () => {
  for (const reason of ['no-local-calls', 'budget-exhausted', 'client-aborted']) {
    assert.ok(loop.includes(`'${reason}'`), `retrievalLoop should report ${reason}`)
  }
  for (const reason of [
    'no-local-calls',
    'budget-exhausted',
    'stream-failed',
    'unparseable-first-turn',
    'continuation-unavailable',
    'continuation-failed',
    'continued',
  ]) {
    assert.ok(stream.includes(reason), `retrievalStream should report ${reason}`)
  }
})

test('no log line carries archive content or an archive hash', () => {
  // A hash is a content identifier for a tool output that may contain
  // credentials, file contents, or source code. The optimizer result therefore
  // carries counts only, and the log serializes the result rather than a hash.
  assert.match(
    optimizer,
    /Counts only: a hash identifies tool output that may/,
    'the archived-count fields must document why no hash is carried',
  )
  assert.doesNotMatch(
    optimizer,
    /archivedHashes|archivedHash\b/,
    'no hash field may exist on the result object',
  )
  const archiveLog = forwarder.slice(
    forwarder.indexOf('[Forwarder] retrieval loop'),
    forwarder.indexOf('[Forwarder] retrieval loop') + 600,
  )
  assert.doesNotMatch(archiveLog, /hash/i,
    'the retrieval loop log must not mention a hash')
})

test('the image slimming log and the compression log use comparable units', () => {
  // Both convert through the same `estimateTextTokens` rule, so an operator can
  // add them: imageCharsSlimmed is a character count, and the optimizer's
  // estimatedSaved is a token count produced by the same estimator family.
  const imageSlim = fs.readFileSync('src/main/proxy/replayImageSlimming.ts', 'utf8')
  assert.match(imageSlim, /export interface ImageSlimResult/)
  assert.match(imageSlim, /charsSlimmed: number/)
  const chat = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const responses = fs.readFileSync('src/main/proxy/routes/responses.ts', 'utf8')
  assert.match(chat, /imageCharsSlimmed/)
  assert.match(responses, /imageCharsSlimmed/)
  // Both routes must state the units are comparable, so an operator knows the two
  // tracks' numbers can be added rather than compared.
  // Match the distinctive fragment. The comment is wrapped across lines with a
  // `//` continuation, so a multi-word regex is brittle; an earlier version of
  // this test asserted a phrase the comment never had.
  assert.match(chat, /units as the text optimizer/,
    'the log comment should state the units are comparable')
  assert.match(responses, /units as the text optimizer/)
})

test('a default deployment changes nothing on the wire', () => {
  // Both features are opt-in. This is the whole reason the retrieval arming is
  // gated on markers being present rather than on the feature flag alone.
  assert.match(
    forwarder,
    /const retrievalArmed = this\.localToolsForRequest\(modifiedRequest\) !== undefined/,
    'arming must be gated on the same predicate that teaches the tool',
  )
  assert.match(forwarder, /if \(retrievalArmed && result\.stream && retrievalContext\)/,
    'the stream wrapper must only apply to an armed request')
})
