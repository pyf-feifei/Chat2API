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

/** Compile a small entry that re-exports the shipped availability predicate. */
async function loadBalancer() {
  const src = fs.readFileSync(
    path.join(repoRoot, 'src', 'main', 'proxy', 'loadbalancer.ts'),
    'utf8',
  )
  const start = src.indexOf('  private isAccountAvailable(account: Account): boolean {')
  assert.ok(start > 0, 'isAccountAvailable not found')
  const open = src.indexOf('{', start)
  const end = src.indexOf('\n  }', open)
  const body = src.slice(open, end + 4)

  const entry = `
    type Account = {
      status: string
      dailyLimit?: number
      todayUsed?: number
      dailyQuotaExhaustedUntil?: number
    }
    class LoadBalancer {
      isAccountAvailable(account: Account): boolean ${body}
    }
    export { LoadBalancer }
  `
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'))
  const out = path.join(dir, 'm.mjs')
  await esbuild.build({
    stdin: { contents: entry, loader: 'ts', resolveDir: repoRoot, sourcefile: 'e.ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  })
  return import(`file:///${out.replace(/\\/g, '/')}`)
}

const acc = (over = {}) => ({ id: 'a', status: 'active', ...over })

describe('load balancer daily-quota isolation', () => {
  it('selects an account with no quota marker', async () => {
    const { LoadBalancer } = await loadBalancer()
    const lb = new LoadBalancer()
    assert.equal(lb.isAccountAvailable(acc()), true)
  })

  it('refuses an account parked by a daily-quota refusal', async () => {
    const { LoadBalancer } = await loadBalancer()
    const lb = new LoadBalancer()
    const parked = acc({ dailyQuotaExhaustedUntil: Date.now() + 20 * 60 * 60 * 1000 })
    assert.equal(lb.isAccountAvailable(parked), false)
  })

  it('returns the account to rotation once the window has elapsed', async () => {
    const { LoadBalancer } = await loadBalancer()
    const lb = new LoadBalancer()
    const elapsed = acc({ dailyQuotaExhaustedUntil: Date.now() - 1000 })
    assert.equal(
      lb.isAccountAvailable(elapsed),
      true,
      'an elapsed window must not keep the account out forever, '
      + 'because resetDailyUsage() has no caller',
    )
  })

  it('still refuses non-active accounts regardless of the marker', async () => {
    const { LoadBalancer } = await loadBalancer()
    const lb = new LoadBalancer()
    assert.equal(lb.isAccountAvailable(acc({ status: 'inactive' })), false)
  })

  it('keeps the legacy dailyLimit guard intact', async () => {
    const { LoadBalancer } = await loadBalancer()
    const lb = new LoadBalancer()
    assert.equal(lb.isAccountAvailable(acc({ dailyLimit: 100, todayUsed: 100 })), false)
    assert.equal(lb.isAccountAvailable(acc({ dailyLimit: 100, todayUsed: 99 })), true)
  })
})
