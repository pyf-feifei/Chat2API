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

/**
 * Load the shipped refresher with the store stubbed out, so the trigger logic
 * can be exercised without touching credentials or the network.
 */
async function loadRefresher() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'))
  const out = path.join(dir, 'm.mjs')
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'proxy', 'adapters', 'qwen-ai-token-refresh.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    external: ['electron'],
    platform: 'node',
    target: 'node20',
    alias: { axios: path.join(here, 'stubs', 'axios-stub.cjs') },
    plugins: [{
      name: 'stub-store',
      setup(build) {
        build.onResolve({ filter: /store\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const storeManager = {
            getAccounts: () => [], getAccount: () => undefined, updateAccount: () => undefined,
            getConfig: () => ({}), addLog: () => undefined,
          }`,
          loader: 'js',
        }))
      },
    }],
  })
  return import(`file:///${out.replace(/\\/g, '/')}`)
}

const ACC = 'acc-1'
// A jar that looks perfectly healthy: it has the session cookie, and the token
// is a JWT that does not expire for two weeks. This is the exact state that
// hid a dead credential on 2026-09-27.
const farFutureJwt = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 14 * 86400 })}.sig`
})()
const healthyAccount = () => ({
  id: ACC,
  providerId: 'qwen-ai',
  status: 'active',
  credentials: { email: 'a@b.c', password: 'pw', token: farFutureJwt, cookies: 'token=abc; acw_tc=x' },
})

describe('refreshIfNeeded challenge trigger', () => {
  it('does not refresh a healthy jar with no failure evidence', async () => {
    const { QwenAiTokenRefresher } = await loadRefresher()
    const r = new QwenAiTokenRefresher()
    const acct = healthyAccount()
    const out = await r.refreshIfNeeded(acct)
    assert.equal(out, acct, 'a healthy session must be returned untouched')
  })

  it('treats a recorded challenge as proof the session is finished', async () => {
    const mod = await loadRefresher()
    const r = new mod.QwenAiTokenRefresher()
    const acct = healthyAccount()
    // The adapter sees a challenge page; record it the way the request path does.
    mod.noteQwenAiChallenge(ACC, '<!doctype html> aliyun_waf_aa ff926c7f07e45e2e487a29a6197d3460')
    // Now the next refresh attempt must not decline. refresh() itself will try
    // the network, so assert the decision rather than the outcome: a declined
    // call returns the same object reference, a refresh attempt does not.
    const settled = await r.refreshIfNeeded(acct).catch(() => 'threw')
    assert.notEqual(settled, acct, 'a challenge must make the refresher act, not decline')
    mod.clearQwenAiChallenge(ACC)
  })

  it('accepts an explicit failure string without any module state', async () => {
    const mod = await loadRefresher()
    const r = new mod.QwenAiTokenRefresher()
    const acct = healthyAccount()
    const settled = await r
      .refreshIfNeeded(acct, undefined, 'RGV587 risk-control verdict')
      .catch(() => 'threw')
    assert.notEqual(settled, acct, 'an explicit verdict must trigger a refresh')
  })

  it('consumes the recorded evidence so one challenge is not a permanent loop', async () => {
    const mod = await loadRefresher()
    const r = new mod.QwenAiTokenRefresher()
    const acct = healthyAccount()
    mod.noteQwenAiChallenge(ACC, 'aliyun_waf_aa')
    await r.refreshIfNeeded(acct).catch(() => {})
    const after = await r.refreshIfNeeded(acct).catch(() => 'threw')
    assert.equal(after, acct, 'the evidence must be cleared once it has been used')
  })

  it('still refreshes when the jar lacks a session cookie', async () => {
    const { QwenAiTokenRefresher } = await loadRefresher()
    const r = new QwenAiTokenRefresher()
    const acct = { ...healthyAccount(), credentials: { ...healthyAccount().credentials, cookies: 'only=x-ap' } }
    const settled = await r.refreshIfNeeded(acct).catch(() => 'threw')
    assert.notEqual(settled, acct)
  })
})
