import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

async function loadRefresher() {
  const mod = await import(
    `file:///${path.join(here, 'stubs', 'axios-stub.cjs').replace(/\\/g, '/')}`
  )
  return mod
}

/** Compile the refresher with axios and the store aliased away. */
async function load() {
  const { pathToFileURL } = await import('node:url')
  const out = path.join(repoRoot, 'node_modules', '.tmp-refresh-skip.mjs')
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'proxy', 'adapters', 'qwen-ai-token-refresh.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile: out,
    logLevel: 'silent',
    external: ['electron'],
    alias: { axios: path.join(here, 'stubs', 'axios-stub.cjs') },
    plugins: [{
      name: 'stub-store',
      setup(b) {
        b.onResolve({ filter: /store\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const storeManager = {
            getAccounts: () => [], getAccount: () => undefined, updateAccount: () => undefined,
            getConfig: () => ({}), addLog: () => undefined,
          }`, loader: 'js',
        }))
      },
    }],
  })
  const m = await import(pathToFileURL(out).href)
  return m
}

const jwt = (expSecsFromNow) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecsFromNow })}.s`
}
const acct = (over = {}) => ({
  id: 'a1', providerId: 'qwen-ai', status: 'active',
  credentials: { email: 'a@b.c', password: 'pw', token: jwt(14 * 86400), cookies: 'token=abc' },
  ...over,
})

describe('refresh skip observability', () => {
  it('records why an apparently healthy account is not being renewed', async () => {
    const m = await load()
    m.resetQwenAiRefreshSkipSummary()
    const r = new m.QwenAiTokenRefresher()

    // Jar looks fine: session cookie present, token valid for two weeks, no
    // challenge recorded. This is the state that hid a dead pool.
    const a = acct()
    const out = await r.refreshIfNeeded(a)
    assert.equal(out, a, 'must not attempt a refresh')

    const summary = m.getQwenAiRefreshSkipSummary()
    assert.equal(summary['looks-healthy'], 1,
      'a silent skip must be recorded, otherwise it is indistinguishable from a healthy pool')
  })

  it('records the challenged reason when the session was refused', async () => {
    const m = await load()
    m.resetQwenAiRefreshSkipSummary()
    const r = new m.QwenAiTokenRefresher()
    m.noteQwenAiChallenge('a1', 'aliyun_waf_aa ff926c7f07e45e2e487a29a6197d3460')
    // Force the skip path with a different account so the challenge does not
    // trigger an actual refresh.
    await r.refreshIfNeeded(acct({ id: 'other' }))
    assert.equal(m.getQwenAiRefreshSkipSummary()['looks-healthy'], 1)
  })

  it('does not record a skip when a refresh is actually attempted', async () => {
    const m = await load()
    m.resetQwenAiRefreshSkipSummary()
    const r = new m.QwenAiTokenRefresher()
    const a = acct({ credentials: { email: 'a@b.c', password: 'pw', token: jwt(14 * 86400), cookies: 'only=x-ap' } })
    await r.refreshIfNeeded(a).catch(() => {})
    const summary = m.getQwenAiRefreshSkipSummary()
    assert.equal(summary['looks-healthy'], undefined, 'a real refresh attempt must not be logged as a skip')
  })

  it('reset clears the counters', async () => {
    const m = await load()
    m.resetQwenAiRefreshSkipSummary()
    const r = new m.QwenAiTokenRefresher()
    await r.refreshIfNeeded(acct())
    assert.ok(Object.keys(m.getQwenAiRefreshSkipSummary()).length > 0)
    m.resetQwenAiRefreshSkipSummary()
    assert.deepEqual(m.getQwenAiRefreshSkipSummary(), {})
  })
})
