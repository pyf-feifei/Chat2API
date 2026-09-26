import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)

/**
 * The policy module self-applies on import and mutates process.env, so each
 * case runs in a fresh child process with a controlled environment.
 *
 * The production build inlines this module into `out-server/server/index.js`,
 * so compile the single source file with the project's esbuild instead of
 * importing a build artifact.
 */
const esbuild = require('esbuild')
const policySource = fs.readFileSync(
  path.join(repoRoot, 'src', 'main', 'proxy', 'egressPolicy.ts'),
  'utf8',
)
const policyModulePath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'egress-policy-')),
  'egressPolicy.mjs',
)
fs.writeFileSync(
  policyModulePath,
  esbuild.transformSync(policySource, { loader: 'ts', format: 'esm', target: 'node20' }).code,
)

function runPolicy(env) {
  const script = `
    process.env.CHAT2API_LOG_LEVEL = ${JSON.stringify(env.CHAT2API_LOG_LEVEL || '')}
    const { applyEgressDirectPolicy, isEgressDirectPolicyApplied } = await import(
      ${JSON.stringify('file:///' + policyModulePath.replace(/\\/g, '/'))}
    )
    applyEgressDirectPolicy()
    const pfe = (await import('proxy-from-env')).default
    const urls = [
      'https://chat.qwen.ai/api/v1/auths/signin',
      'https://chat.qwen.ai/api/v2/chat/completions',
      'https://chat2.qianwen.com/api/v2/chat',
      'https://chat2-api.qianwen.com',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://api.anthropic.com/v1/messages',
      'https://www.google.com',
      'https://api.example.com/v1/chat',
      'https://sub.another.test/v1/chat',
      'http://127.0.0.1:8080/v1/chat/completions',
      'http://localhost:5173',
    ]
    console.log(JSON.stringify({
      noProxy: process.env.NO_PROXY || '',
      applied: isEgressDirectPolicyApplied(),
      routes: urls.map((u) => [u, pfe.getProxyForUrl(u) || 'DIRECT']),
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HTTP_PROXY: env.HTTP_PROXY,
      HTTPS_PROXY: env.HTTPS_PROXY,
      http_proxy: env.http_proxy,
      https_proxy: env.https_proxy,
      NO_PROXY: env.NO_PROXY,
      no_proxy: env.no_proxy,
      CHAT2API_EGRESS_DIRECT: env.CHAT2API_EGRESS_DIRECT,
      CHAT2API_EGRESS_DIRECT_EXTRA: env.CHAT2API_EGRESS_DIRECT_EXTRA,
      CHAT2API_LOG_LEVEL: env.CHAT2API_LOG_LEVEL,
    },
  })
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function parseRoutes(stdout) {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  assert.ok(line, `no JSON payload in stdout:\n${stdout}`)
  const parsed = JSON.parse(line)
  return Object.fromEntries(parsed.routes)
}

describe('egress direct policy', () => {
  it('routes provider domains direct even when a proxy is configured', () => {
    const res = runPolicy({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1,localhost',
    })
    assert.equal(res.status, 0, res.stderr)
    const routes = parseRoutes(res.stdout)

    // The regression that triggered this module (2026-09-25).
    assert.equal(routes['https://chat.qwen.ai/api/v1/auths/signin'], 'DIRECT')
    assert.equal(routes['https://chat.qwen.ai/api/v2/chat/completions'], 'DIRECT')
    assert.equal(routes['https://chat2.qianwen.com/api/v2/chat'], 'DIRECT')
    assert.equal(routes['https://chat2-api.qianwen.com'], 'DIRECT')
    assert.equal(
      routes['https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
      'DIRECT',
    )

    // Loopback must stay direct even without any policy input.
    assert.equal(routes['http://127.0.0.1:8080/v1/chat/completions'], 'DIRECT')
    assert.equal(routes['http://localhost:5173'], 'DIRECT')

    // Unrelated traffic keeps using the proxy: the policy must not disable it.
    assert.equal(routes['https://api.anthropic.com/v1/messages'], 'http://127.0.0.1:7897')
    assert.equal(routes['https://www.google.com'], 'http://127.0.0.1:7897')
  })

  it('preserves a pre-existing NO_PROXY and never duplicates entries', () => {
    const res = runPolicy({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1,localhost,.internal.example',
    })
    assert.equal(res.status, 0, res.stderr)
    const line = res.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'))
    const parsed = JSON.parse(line)
    const noProxy = parsed.noProxy

    assert.ok(noProxy.includes('.internal.example'), 'pre-existing entry dropped')
    assert.ok(noProxy.includes('127.0.0.1'), 'loopback entry dropped')
    assert.ok(noProxy.includes('.qwen.ai'), 'qwen entry missing')

    // Re-applying must be idempotent.
    const second = runPolicy({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: noProxy,
    })
    const secondLine = second.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'))
    const secondNoProxy = JSON.parse(secondLine).noProxy
    assert.equal(secondNoProxy, noProxy, 'applying twice duplicated entries')
  })

  it('honours CHAT2API_EGRESS_DIRECT=off', () => {
    const res = runPolicy({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1,localhost',
      CHAT2API_EGRESS_DIRECT: 'off',
    })
    assert.equal(res.status, 0, res.stderr)
    const routes = parseRoutes(res.stdout)
    assert.equal(routes['https://chat.qwen.ai/api/v1/auths/signin'], 'http://127.0.0.1:7897')
  })

  it('accepts an explicit domain list and extra domains', () => {
    const res = runPolicy({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1,localhost',
      CHAT2API_EGRESS_DIRECT: 'example.com',
      CHAT2API_EGRESS_DIRECT_EXTRA: 'another.test',
    })
    assert.equal(res.status, 0, res.stderr)
    const routes = parseRoutes(res.stdout)

    // The override list replaces the defaults...
    assert.equal(routes['https://api.example.com/v1/chat'], 'DIRECT')
    assert.equal(routes['https://sub.another.test/v1/chat'], 'DIRECT')
    // ...so the built-in Qwen entries are no longer applied.
    assert.equal(routes['https://chat.qwen.ai/api/v1/auths/signin'], 'http://127.0.0.1:7897')
    // Unrelated traffic is untouched.
    assert.equal(routes['https://www.google.com'], 'http://127.0.0.1:7897')
  })

  it('normalises a bare domain so subdomains match', () => {
    const res = runPolicy({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1,localhost',
      CHAT2API_EGRESS_DIRECT: 'qwen.ai',
    })
    assert.equal(res.status, 0, res.stderr)
    const routes = parseRoutes(res.stdout)
    assert.equal(routes['https://chat.qwen.ai/api/v1/auths/signin'], 'DIRECT')
  })
})
