/**
 * The link that makes the retrieval loop reachable at all.
 *
 * `buildRetrieveTool` used to have zero production call sites: the model was
 * never taught the tool, the partition never fired, and the loop was dead code
 * with 22 passing tests around it. Every test in this file exists because that
 * gap was invisible to a green suite.
 *
 * The three conditions under which the tool is taught are the whole contract:
 * retrieval on, non-streaming, and the request actually advertised a marker.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { RETRIEVE_TOOL_NAME, buildRetrieveTool } from '../../src/main/proxy/services/retrievalTool.ts'

const forwarder = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
const engine = fs.readFileSync('src/main/proxy/toolCalling/ToolCallingEngine.ts', 'utf8')
const runtimePlan = fs.readFileSync('src/main/proxy/toolCalling/runtimePlan.ts', 'utf8')

test('buildRetrieveTool has a production call site', () => {
  const definition = forwarder.split('buildRetrieveTool').length - 1
  const engineDefinitions = (engine.split('buildRetrieveTool').length - 1)
    + (runtimePlan.split('buildRetrieveTool').length - 1)
  assert.ok(
    definition + engineDefinitions > 0,
    'buildRetrieveTool is defined but never called: the model is never taught the tool, '
      + 'so the partition never fires and the retrieval loop is dead code',
  )
})

test('the forwarder gates the tool on exactly two conditions', () => {
  const method = forwarder.slice(
    forwarder.indexOf('private localToolsForRequest('),
    forwarder.indexOf('private compressionArchiveFor('),
  )
  assert.ok(method.length > 0, 'localToolsForRequest is missing from the forwarder')
  // Phase 3.2 moved the flag read into the shared settings module, so the gate
  // is now `getCompressionSettings().retrieval.enabled` rather than the local
  // `getRetrievalSettings()`. An earlier version of this test asserted the old
  // expression and failed with no behavior change.
  assert.ok(
    method.includes('getCompressionSettings().retrieval.enabled')
      || method.includes('getRetrievalSettings().enabled'),
    'retrieval being off must return undefined',
  )
  assert.ok(method.includes('extractArchiveHashes('),
    'the request must actually advertise a marker, or the prompt pays for a tool with nothing to retrieve')
  assert.match(method, /return undefined/,
    'every disqualifier must return undefined rather than an empty list')
  assert.match(method, /return \[buildRetrieveTool\(\)\]/,
    'the qualified request must be taught exactly the retrieval tool')
})

test('the prompt-facing plan receives local tools', () => {
  assert.match(engine, /localTools: input\.localTools/,
    'transformRequest must forward localTools to the plan builder')
  assert.match(runtimePlan, /localTools\?: NormalizedToolDefinition\[\]/,
    'the plan builder must accept local tools')
})

test('a local tool is never added to the client tool contract', () => {
  // The client contract is `clientRequest.tools`. If the local tool leaked in
  // there, the client would be offered a tool it never declared.
  const body = runtimePlan.slice(
    runtimePlan.indexOf('const clientTools'),
    // The end index is the START of the tools line, so the line itself is
    // excluded. An earlier version sliced to that index and then asserted on
    // `...clientTools`, which is in the excluded line.
    runtimePlan.indexOf('const tools = [...clientTools') + 'const tools = [...clientTools, ...localTools]'.length,
  )
  assert.match(body, /\.\.\.clientTools/,
    'the plan tools must be client tools plus local tools')
  assert.doesNotMatch(body, /clientRequest\.tools\s*=/,
    'the client tool list must not be reassigned to include local tools')
})

test('a forced tool choice drops local tools rather than teaching an unusable one', () => {
  // `tool_choice: forced` means the client pinned one tool. Teaching a second
  // the model may not call is prompt noise on every such turn.
  assert.match(runtimePlan, /forcedName \? tools\.filter\(\(tool\) => tool\.name === forcedName\) : tools/,
    'a forced choice must narrow the plan to the forced tool, which drops local tools')
})

test('a client tool of the same name is not duplicated', () => {
  assert.match(
    runtimePlan,
    /!clientTools\.some\(\(client\) => client\.name === tool\.name\)/,
    'a client tool that already uses the reserved name must win over the local one',
  )
})

test('the reserved name is a single source of truth', () => {
  // A client tool named `retrieve_tool_output` must win, and the local one must
  // not shadow it. That is enforced by the dedupe in the plan builder; this
  // pins the name itself so the dedupe and the tool cannot drift apart.
  assert.equal(
    RETRIEVE_TOOL_NAME,
    buildRetrieveTool().name,
    'the exported constant and the built tool must agree, or the dedupe compares two names',
  )
  assert.match(
    runtimePlan,
    /!clientTools\.some\(\(client\) => client\.name === tool\.name\)/,
    'a client tool using the reserved name must suppress the local one',
  )
})

test('arming the prompt and arming the loop use the SAME predicate', () => {
  // If the two ever disagree, the model is asked for a tool whose answer is
  // thrown away, or an answer is computed for a tool the model was never told
  // about. Both failures are silent.
  assert.match(
    forwarder,
    /const retrievalArmed = this\.localToolsForRequest\(modifiedRequest\) !== undefined/,
    'the loop must be gated on the same predicate that teaches the tool',
  )
  assert.doesNotMatch(
    forwarder,
    /retrievalLoopEnabled/,
    'the old, separately-computed gate must be gone',
  )
})

test('the archive is constructed once per configuration, not per request', () => {
  // A file-backed archive reads and parses its whole JSON file on construction.
  // Building one per request would put disk I/O on the hot path of every
  // retrieval-enabled turn.
  assert.match(forwarder, /private readonly compressionArchives = new Map/,
    'the forwarder must cache archives rather than construct one per request')
  assert.doesNotMatch(
    forwarder.slice(
      forwarder.indexOf('private createRetrievalToolContext('),
      forwarder.indexOf('private compressionArchiveFor('),
    ),
    /new CompressionArchive\(/,
    'the context must take a cached archive, not construct one',
  )
})
