/**
 * Compression settings parsing and backend resolution.
 *
 * The property that matters most: an unparseable value never becomes a
 * dependency. Every unknown mode resolves to `ts`, which is always registered and
 * always available, so no configuration can make a request fail.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  getCompressionSettings,
  resolveCompressionBackend,
} from '../../../src/main/proxy/services/compressionSettings.ts'
import { DEFAULT_MAX_RETRIEVALS_PER_REQUEST } from '../../../src/main/proxy/services/retrievalTool.ts'

test('a clean environment resolves to the guaranteed backend with everything off', () => {
  const settings = getCompressionSettings({})
  assert.equal(settings.mode, 'ts')
  assert.equal(settings.retrieval.enabled, false)
  assert.equal(settings.retrieval.maxRetrievalsPerRequest, DEFAULT_MAX_RETRIEVALS_PER_REQUEST)
  assert.equal(settings.archiveTtlMs, 86_400_000)
  assert.equal(settings.archiveMaxChars, 67_108_864)
})

test('the backend mode parses wasm, python, auto and ts', () => {
  for (const value of ['ts', 'wasm', 'python', 'auto', 'WASM', ' auto ']) {
    assert.equal(
      getCompressionSettings({ CHAT2API_COMPRESS_BACKEND: value }).mode,
      value.trim().toLowerCase() as never,
      `value=${value}`,
    )
  }
})

test('an unknown backend mode resolves to ts rather than guessing', () => {
  // The failure this prevents: a deployment setting CHAT2API_COMPRESS_BACKEND=rs
  // and getting a request error instead of a working backend.
  for (const value of ['rs', 'onnx', 'yes', '1', '', '  ']) {
    assert.equal(getCompressionSettings({ CHAT2API_COMPRESS_BACKEND: value }).mode, 'ts', `value=${value}`)
  }
})

test('retrieval is opt-in and unknown values stay off', () => {
  for (const value of ['on', '1', 'true', 'yes', 'enabled', 'ON']) {
    assert.equal(getCompressionSettings({ CHAT2API_COMPRESS_RETRIEVAL: value }).retrieval.enabled, true, value)
  }
  for (const value of ['off', '0', 'false', 'no', 'maybe', '']) {
    assert.equal(getCompressionSettings({ CHAT2API_COMPRESS_RETRIEVAL: value }).retrieval.enabled, false, value)
  }
})

test('archive bounds parse as non-negative integers with safe defaults', () => {
  assert.equal(getCompressionSettings({ CHAT2API_COMPRESS_ARCHIVE_TTL_MS: '0' }).archiveTtlMs, 0)
  assert.equal(getCompressionSettings({ CHAT2API_COMPRESS_ARCHIVE_TTL_MS: '1000' }).archiveTtlMs, 1000)
  for (const value of ['', 'forever', '-1', '1.5']) {
    assert.equal(
      getCompressionSettings({ CHAT2API_COMPRESS_ARCHIVE_TTL_MS: value }).archiveTtlMs,
      86_400_000,
      `value=${JSON.stringify(value)}`,
    )
  }
  assert.equal(getCompressionSettings({ CHAT2API_COMPRESS_ARCHIVE_MAX_CHARS: '1024' }).archiveMaxChars, 1024)
})

test('every backend mode resolves to a working backend', async () => {
  for (const mode of ['ts', 'wasm', 'python', 'auto'] as const) {
    const backend = await resolveCompressionBackend(mode)
    assert.ok(backend, `${mode} yielded no backend`)
    assert.equal(typeof backend.compact, 'function')
    // The reference implementation must always be reachable.
    assert.equal(await backend.available(), true, `${mode} reported unavailable`)
  }
})

test('an unknown mode still resolves rather than throwing', async () => {
  const backend = await resolveCompressionBackend('nonsense' as never)
  assert.equal(backend.id, 'ts')
})

test('the forwarder reads the backend mode from the shared settings module', () => {
  // A second settings reader in the forwarder is how the documented default and
  // the effective one drift apart.
  const forwarder = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  assert.match(
    forwarder,
    /from '\.\/services\/compressionSettings\.ts'/,
    'the forwarder should import the shared compression settings',
  )
  assert.doesNotMatch(
    forwarder,
    /CHAT2API_COMPRESS_BACKEND/,
    'the forwarder must not read the backend env directly',
  )
})
