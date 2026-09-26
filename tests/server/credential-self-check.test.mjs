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

const ENCRYPTION_PREFIX = 'c2a:v1:'

/** The self-check module only needs the prefix constant, so stub the import. */
async function loadSelfCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-check-'))
  const out = path.join(dir, 'm.mjs')
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'store', 'credentialSelfCheck.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
    plugins: [{
      name: 'stub-runtime-types',
      setup(build) {
        build.onResolve({ filter: /runtime\/types$/ }, () => ({ path: 'rt', namespace: 'stub' }))
        build.onResolve({ filter: /proxy\/types$/ }, () => ({ path: 'pt', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents: a.path === 'rt'
            ? `export const ENCRYPTION_PREFIX = ${JSON.stringify(ENCRYPTION_PREFIX)}`
            : 'export type Account = any',
          loader: 'js',
        }))
      },
    }],
  })
  return import(`file:///${out.replace(/\\/g, '/')}`)
}

const acc = (credentials) => ({ id: 'a1', providerId: 'qwen-ai', status: 'active', credentials })
const enc = (s) => `${ENCRYPTION_PREFIX}${Buffer.from(s).toString('base64')}`

describe('credential self check', () => {
  it('passes when accounts carry a session cookie and encryption works', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    const r = inspectCredentialHealth(
      [acc({ cookies: 'token=abc; qwen-locale=zh' }), acc({ cookies: 'token=def' })],
      true,
      (v) => v,
    )
    assert.equal(r.fatal, false)
    assert.equal(r.problems.length, 0)
    assert.equal(r.sessionReady, 2)
    assert.equal(r.encryptedLooking, 0)
  })

  it('detects the missing-key case: encrypted data, no encryption runtime', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    const accounts = [
      acc({ cookies: enc('token=abc'), token: enc('tok') }),
      acc({ cookies: enc('token=def'), token: enc('tok') }),
    ]
    // Identity decrypt is exactly what the runtime does without a key.
    const r = inspectCredentialHealth(accounts, false, (v) => v)

    assert.equal(r.fatal, true, 'must be fatal')
    assert.equal(r.sessionReady, 0)
    assert.equal(r.encryptedLooking, 2)
    assert.match(r.problems[0], /CHAT2API_STORAGE_ENCRYPTION_KEY/)
    assert.match(r.problems[0], /docker run/)
  })

  it('is not fatal when encryption is simply absent and the store is plaintext', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    const r = inspectCredentialHealth([acc({ cookies: 'token=plain' })], false, (v) => v)
    assert.equal(r.fatal, false)
    assert.equal(r.sessionReady, 1)
  })

  it('warns when decryptable but nothing has a session cookie', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    const r = inspectCredentialHealth(
      [acc({ cookies: 'qwen-locale=zh' }), acc({ cookies: 'x-ap=1' })],
      true,
      (v) => v,
    )
    assert.equal(r.fatal, false)
    assert.equal(r.sessionReady, 0)
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /signin/)
    assert.match(r.problems[0], /email not found/)
  })

  it('treats a working decryptor as readable even if the runtime flag is false', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    const secrets = new Map([[enc('token=one'), 'token=one']])
    const decrypt = (v) => secrets.get(v) ?? v

    // Decryptable + session present => nothing is wrong, whatever the flag
    // says. The flag is only a hint; the data is the ground truth.
    const ok = inspectCredentialHealth([acc({ cookies: enc('token=one') })], false, decrypt)
    assert.equal(ok.fatal, false)
    assert.equal(ok.sessionReady, 1)
    assert.equal(ok.encryptedLooking, 0)

    // Same data, no working decryptor => the prefix survives => fatal.
    const broken = inspectCredentialHealth([acc({ cookies: enc('token=one') })], false, (v) => v)
    assert.equal(broken.fatal, true)
    assert.equal(broken.encryptedLooking, 1)
  })

  it('does not misreport a working key: stored values are expected to look encrypted', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    // A real decryptor: the stored blob keeps the prefix, decryption strips it.
    const secrets = new Map([
      [enc('token=one; acw_tc=x'), 'token=one; acw_tc=x'],
      [enc('token=two'), 'token=two'],
    ])
    const r = inspectCredentialHealth(
      [acc({ cookies: enc('token=one; acw_tc=x') }), acc({ cookies: enc('token=two') })],
      true,
      (v) => secrets.get(v) ?? v,
    )
    assert.equal(r.encryptedLooking, 0, 'prefix on stored data is normal when a key exists')
    assert.equal(r.sessionReady, 2)
    assert.equal(r.fatal, false)
    assert.equal(r.problems.length, 0, 'must not warn when every account decrypts to a session')
  })

  it('ignores accounts with no credentials at all', async () => {
    const { inspectCredentialHealth } = await loadSelfCheck()
    const r = inspectCredentialHealth(
      [acc({}), { id: 'x', providerId: 'mimo' }],
      false,
      (v) => v,
    )
    assert.equal(r.inspected, 0)
    assert.equal(r.fatal, false)
    assert.equal(r.problems.length, 0)
  })

  it('assertCredentialHealth throws on the fatal case', async () => {
    const { assertCredentialHealth } = await loadSelfCheck()
    const saved = process.env.CHAT2API_CREDENTIAL_SELF_CHECK
    delete process.env.CHAT2API_CREDENTIAL_SELF_CHECK
    try {
      assert.throws(
        () => assertCredentialHealth([acc({ cookies: enc('token=a') })], false, (v) => v),
        /CHAT2API_STORAGE_ENCRYPTION_KEY|unreadable/i,
      )
    } finally {
      if (saved !== undefined) process.env.CHAT2API_CREDENTIAL_SELF_CHECK = saved
    }
  })

  it('does not throw on the fatal case when explicitly bypassed', async () => {
    const { assertCredentialHealth } = await loadSelfCheck()
    const saved = process.env.CHAT2API_CREDENTIAL_SELF_CHECK
    process.env.CHAT2API_CREDENTIAL_SELF_CHECK = 'off'
    try {
      const r = assertCredentialHealth([acc({ cookies: enc('token=a') })], false, (v) => v)
      assert.equal(r.fatal, true)
    } finally {
      if (saved === undefined) delete process.env.CHAT2API_CREDENTIAL_SELF_CHECK
      else process.env.CHAT2API_CREDENTIAL_SELF_CHECK = saved
    }
  })
})
