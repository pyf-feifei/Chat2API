import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

/** The mask/generation module is self-contained apart from the shared type. */
async function loadApiKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-keys-'))
  const out = path.join(dir, 'm.mjs')
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'store', 'apiKeys.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  })
  return import(`file:///${out.replace(/\\/g, '/')}`)
}

// The two shapes a real key is ever written in.
const REAL_DESKTOP_KEY = 'sk-' + 'a1B2c3D4'.repeat(6)
const REAL_SERVER_KEY = 'sk-mgmt-' + '0123456789abcdef'.repeat(2)

describe('api key masking', () => {
  it('generates values that are never mistaken for a mask', async () => {
    const { generateApiKeyValue, isMaskedApiKeyValue } = await loadApiKeys()

    for (let i = 0; i < 200; i++) {
      const value = generateApiKeyValue()
      assert.equal(isMaskedApiKeyValue(value), false, `rejected a freshly generated key: ${value}`)
    }
  })

  it('generates distinct values', async () => {
    const { generateApiKeyValue } = await loadApiKeys()
    const seen = new Set()
    for (let i = 0; i < 500; i++) seen.add(generateApiKeyValue())
    assert.equal(seen.size, 500)
  })

  it('recognises every mask the read paths can produce', async () => {
    const { isMaskedApiKeyValue, maskApiKeyValue, API_KEY_PREFIX } = await loadApiKeys()

    // GET /v0/management/config replaces the value with this literal.
    assert.equal(isMaskedApiKeyValue('***'), true)
    assert.equal(isMaskedApiKeyValue('****'), true)
    // GET /v0/management/api-keys returns `${prefix}...${last8}`.
    assert.equal(isMaskedApiKeyValue(maskApiKeyValue(REAL_DESKTOP_KEY)), true)
    assert.equal(isMaskedApiKeyValue(`${API_KEY_PREFIX}...`), true)
    // The renderer masks a second time as `sk-xxx****yyyy`.
    assert.equal(isMaskedApiKeyValue('sk-abc****wxyz'), true)
    // Degenerate values a round-trip could produce.
    assert.equal(isMaskedApiKeyValue(''), true)
    assert.equal(isMaskedApiKeyValue('   '), true)
    assert.equal(isMaskedApiKeyValue(undefined), true)
    assert.equal(isMaskedApiKeyValue(null), true)
    assert.equal(isMaskedApiKeyValue(12345), true)
  })

  it('accepts both real key formats', async () => {
    const { isMaskedApiKeyValue } = await loadApiKeys()
    assert.equal(isMaskedApiKeyValue(REAL_DESKTOP_KEY), false)
    assert.equal(isMaskedApiKeyValue(REAL_SERVER_KEY), false)
    // A key with surrounding whitespace from a hand-edited store is still real.
    assert.equal(isMaskedApiKeyValue(`  ${REAL_SERVER_KEY}  `), false)
  })

  it('keeps the last 8 characters when masking a real key', async () => {
    const { maskApiKeyValue, API_KEY_PREFIX } = await loadApiKeys()
    assert.equal(maskApiKeyValue(REAL_SERVER_KEY), `${API_KEY_PREFIX}...${REAL_SERVER_KEY.slice(-8)}`)
    assert.equal(REAL_SERVER_KEY.endsWith('89abcdef'), true)
    // At or below the 8-character threshold there is no suffix worth keeping:
    // reveal nothing rather than most of the key.
    assert.equal(maskApiKeyValue('sk-ab'), `${API_KEY_PREFIX}...`)
    assert.equal(maskApiKeyValue('12345678'), `${API_KEY_PREFIX}...`)
  })

  it('names the affected keys so the rejection is actionable', async () => {
    const { maskedApiKeyNames } = await loadApiKeys()

    assert.deepEqual(
      maskedApiKeyNames([
        { id: '1', name: '11', key: '***' },
        { id: '2', name: 'healthy', key: REAL_SERVER_KEY },
        { id: '3', key: 'sk-mgmt-...abcd' },
        { id: '4', name: '', key: '' },
      ]),
      ['11', '<unnamed>', '<unnamed>'],
    )
  })

  it('reports nothing for a clean array and tolerates junk', async () => {
    const { maskedApiKeyNames } = await loadApiKeys()
    assert.deepEqual(maskedApiKeyNames([{ id: '1', name: 'a', key: REAL_DESKTOP_KEY }]), [])
    assert.deepEqual(maskedApiKeyNames(undefined), [])
    assert.deepEqual(maskedApiKeyNames('not an array'), [])
  })
})

describe('the API Key page cannot round-trip a mask into the store', () => {
  // The failure this guards: the page read config.apiKeys (every key masked to
  // `***`), then wrote the whole array back on add/delete/toggle. One key
  // created, six real keys overwritten with the literal string `***`, enabled
  // toggles still green, clients silently getting 401.
  const pagePath = path.join(repoRoot, 'src', 'renderer', 'src', 'pages', 'ApiKeys.tsx')
  const source = fs.readFileSync(pagePath, 'utf8')

  it('never writes the apiKeys array through the generic config channel', () => {
    assert.doesNotMatch(
      source,
      /updateConfig\(\s*\{\s*apiKeys/,
      'ApiKeys.tsx still calls updateConfig({ apiKeys }) — that replaces the stored array with masked values',
    )
  })

  it('does not generate key values in the renderer', () => {
    // Generation belongs to the server, which appends to the stored array, so
    // no other key is read and rewritten in the process.
    assert.doesNotMatch(source, /function generateApiKey/, 'key generation belongs in src/main/store/apiKeys.ts')
  })

  it('uses the per-key operations for add, update and remove', () => {
    assert.match(source, /apiKeys\.add\(/)
    assert.match(source, /apiKeys\.update\(/)
    assert.match(source, /apiKeys\.remove\(/)
  })
})

describe('the config store refuses a masked apiKeys write', () => {
  const configPath = path.join(repoRoot, 'src', 'main', 'store', 'config.ts')
  const source = fs.readFileSync(configPath, 'utf8')

  it('guards both the validate and the update path', () => {
    // validate() produces the caller-facing 400; update() is the choke point the
    // IPC path reaches directly, so both must check.
    assert.match(source, /assertNoMaskedApiKeys\(updates\)/)
    assert.match(source, /maskedApiKeyNames\(\(config as \{ apiKeys\?: unknown \}\)\.apiKeys\)/)
  })
})
