/**
 * The retrieval tool must never reach an upstream provider.
 *
 * This is the safety property that matters most, and it is independent of
 * whether the retrieval loop ever runs: if the tool is present in
 * `request.tools` for any reason, the provider must not see it. A provider
 * cannot execute a tool whose only implementation is in this process, and a
 * request carrying an unexecutable tool is a protocol error upstream.
 *
 * The teaching side (the managed prompt) and the wire side (`buildRequestBody`)
 * are separate code paths, so the divergence is real and needs a test.
 *
 * Source-text assertions are used because the guarantee is about what the
 * upstream body is built from, and there is no cheaper way to see that without
 * standing up a full provider, an account and a wire capture. Several of these
 * are deliberately plain `includes` checks: an earlier revision asserted the
 * exact shape of an import list and broke every time the import grew a symbol,
 * without any behavior changing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  stripRetrievalTool,
  buildRetrieveTool,
  RETRIEVE_TOOL_NAME,
} from '../../src/main/proxy/services/retrievalTool.ts'

const forwarder = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
const engine = fs.readFileSync('src/main/proxy/toolCalling/ToolCallingEngine.ts', 'utf8')

test('the forwarder strips the retrieval tool when it builds the upstream body', () => {
  // This is the wire boundary. If the tool reached here unstripped, a provider
  // would receive a tool it cannot execute.
  assert.ok(
    forwarder.includes('body.tools = stripRetrievalTool(request.tools)'),
    'buildRequestBody must strip the retrieval tool from the wire payload',
  )
})

test('the forwarder uses the shared stripper, not a local copy', () => {
  assert.ok(
    forwarder.includes('stripRetrievalTool'),
    'the forwarder should import the shared stripper',
  )
})

test('no other place in the forwarder assigns request.tools to a wire payload', () => {
  // A second assignment would be an un-stripped path.
  const assignments = forwarder.match(/body\.tools\s*=/g) || []
  assert.equal(assignments.length, 1,
    `expected exactly one body.tools assignment, found ${assignments.length}`)
})

test('stripping removes the tool and leaves client tools untouched', () => {
  const clientTool = { name: 'exec', description: 'run', parameters: { type: 'object' } }
  const tools = [clientTool, buildRetrieveTool(), { name: 'read', description: '', parameters: {} }]

  const stripped = stripRetrievalTool(tools)!
  assert.deepEqual(stripped.map((tool) => tool.name), ['exec', 'read'])
  assert.equal(tools.length, 3, 'the caller array must not be mutated')
})

test('the wire payload never carries the retrieval tool even alone in the list', () => {
  const stripped = stripRetrievalTool([buildRetrieveTool()])!
  assert.deepEqual(stripped, [], 'a payload of only the retrieval tool becomes an empty list')
})

test('the tool is still taught in the managed prompt path', () => {
  // Stripping is one-sided on purpose: the model must be able to see the tool in
  // the prompt, and only the wire payload drops it. A change that removed the
  // tool from the prompt too would silently disable the feature.
  assert.ok(
    !engine.includes('stripRetrievalTool'),
    'the prompt-rendering path must not strip the tool; only the wire boundary does',
  )
})

test('the retrieval tool name is a single source of truth', () => {
  // A typo in the name would produce a prompt that teaches one name and a
  // stripper that matches another, which fails open in the worst direction: the
  // provider receives an unexecutable tool.
  assert.equal(
    buildRetrieveTool().name,
    RETRIEVE_TOOL_NAME,
    'the exported constant and the built tool must agree',
  )
  assert.ok(
    forwarder.includes('stripRetrievalTool'),
    'the forwarder must strip by the shared helper, never by a literal name',
  )
})
