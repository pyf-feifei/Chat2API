/**
 * A/B quality driver: two container states, one task set, one diff.
 *
 * The features are environment variables, not per-request options, so the only
 * honest A/B is two containers. This starts each, runs the same task set against
 * it, and reports the difference.
 *
 * The account pool is shared with the live deployment, so a verification run must
 * not overlap with a run of the same shape. Run this when nothing else is
 * hitting the proxy, and be aware that both runs will move the account
 * cooldown timers in the shared data volume.
 *
 * Usage:
 *   node scripts/compress/run-quality-ab.mjs --key <k> [--limit 16] [--keep]
 */

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const KEY = arg('key', '')
const LIMIT = arg('limit', '16')
const IMAGE = arg('image', 'chat2api-local:latest')
const VOLUME = arg('volume', 'chat2api_chat2api-data')
const KEEP = args.includes('--keep')
if (!KEY) { console.error('missing --key'); process.exit(1) }

const BASE = 'http://127.0.0.1:8080'
const ENCRYPTION_KEY = (() => {
  const line = fs.readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => /^\s*CHAT2API_STORAGE_ENCRYPTION_KEY=/.test(l))
  return line ? line.replace(/^[^=]*=/, '').trim() : ''
})()
if (!ENCRYPTION_KEY) {
  console.error('CHAT2API_STORAGE_ENCRYPTION_KEY is not in .env; a container without it reads')
  console.error('zero credentials and every request 403s. Refusing to run that again.')
  process.exit(1)
}

const ON = {
  CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'always',
  CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '1',
  CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '1',
  CHAT2API_REPLAY_SLIM_IMAGES: 'always',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER: 'balanced',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS: '0',
  CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES: '8',
  CHAT2API_COMPRESS_RETRIEVAL: 'on',
}

function start(envVars) {
  spawnSync('docker', ['rm', '-f', 'chat2api'])
  const cmd = ['run', '-d', '--name', 'chat2api', '-p', '8080:8080',
    '-e', `CHAT2API_STORAGE_ENCRYPTION_KEY=${ENCRYPTION_KEY}`,
    '-v', `${VOLUME}:/data`]
  for (const [k, v] of Object.entries(envVars)) cmd.push('-e', `${k}=${v}`)
  cmd.push(IMAGE)
  const started = spawnSync('docker', cmd, { encoding: 'utf8' })
  if (started.status !== 0) {
    console.error('start failed:', started.stderr)
    process.exit(1)
  }
  return spawnSync('docker', ['inspect', 'chat2api', '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim().slice(0, 12)
}

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise((res) => setTimeout(res, 500))
  }
  return false
}

async function runState(label, envVars, outFile) {
  const id = start(envVars)
  if (!(await waitHealthy())) { console.error(`${label}: never became healthy`); process.exit(1) }
  const logs = spawnSync('docker', ['logs', 'chat2api'], { encoding: 'utf8' }).stdout || ''
  const ready = /ready=(\d+)\s+pending=(\d+)/.exec(logs)
  console.log(`\n${label}: container ${id}, [Session Repair] ready=${ready?.[1]} pending=${ready?.[2]}`)
  if (ready && Number(ready[1]) === 0) {
    console.error('  credentials are unreadable; every request would 403. Aborting.')
    process.exit(1)
  }

  const run = spawnSync('node', ['scripts/compress/quality-one-state.mjs',
    '--key', KEY, '--out', outFile, '--label', label,
    '--limit', LIMIT, '--gap', arg('gap', '15000'), '--arm', arg('arm', 'all')],
  { encoding: 'utf8', stdio: 'inherit' })
  if (run.status !== 0) { console.error(`${label}: task run failed`); process.exit(1) }

  // The container must not have been replaced mid-run by another agent, or the
  // log-derived numbers would be someone else's.
  const after = spawnSync('docker', ['inspect', 'chat2api', '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim().slice(0, 12)
  if (after !== id) console.error(`  WARNING: container was replaced during the run (${id} -> ${after})`)
  return JSON.parse(fs.readFileSync(outFile, 'utf8'))
}

function report(off, on) {
  const byId = new Map(off.results.map((r) => [r.id, r]))
  console.log('\n' + '='.repeat(72))
  console.log('QUALITY A/B  (features off vs on, same model, same tasks)')
  console.log('='.repeat(72))
  console.log('  task          arm  off   on    verdict')
  let regression = 0
  let improvement = 0
  for (const b of on.results) {
    const a = byId.get(b.id)
    if (!a) continue
    const verdict = a.pass === b.pass
      ? (a.pass ? 'same ok' : 'same wrong')
      : (b.pass ? 'IMPROVED' : 'REGRESSION')
    if (verdict === 'REGRESSION') regression += 1
    if (verdict === 'IMPROVED') improvement += 1
    console.log(`  ${b.id.padEnd(13)} ${b.arm}    ${String(a.pass).padEnd(5)} ${String(b.pass).padEnd(5)} ${verdict}`)
    if (verdict === 'REGRESSION') {
      console.log(`      off -> ${JSON.stringify(a.reply.slice(0, 60))}`)
      console.log(`      on  -> ${JSON.stringify(b.reply.slice(0, 60))}`)
    }
  }
  const aDelta = 100 * (on.armA.pass - off.armA.pass) / Math.max(off.armA.n, 1)
  const bDelta = 100 * (on.armB.pass - off.armB.pass) / Math.max(off.armB.n, 1)
  console.log('-'.repeat(72))
  console.log(`  Arm A regression  off ${off.armA.pass}/${off.armA.n}  on ${on.armA.pass}/${on.armA.n}`
    + `   delta ${aDelta >= 0 ? '+' : ''}${aDelta.toFixed(1)} pp`)
  console.log(`  Arm B tradeoff    off ${off.armB.pass}/${off.armB.n}  on ${on.armB.pass}/${on.armB.n}`
    + `   delta ${bDelta >= 0 ? '+' : ''}${bDelta.toFixed(1)} pp`)
  console.log(`  median latency    off ${off.armA.medianLatency}ms  on ${on.armA.medianLatency}ms`)
  console.log(`  tool calls seen   off ${off.armA.toolCallTotal + off.armB.toolCallTotal}`
    + `  on ${on.armA.toolCallTotal + on.armB.toolCallTotal}`)
  console.log('='.repeat(72))
  console.log(`\n  Arm A regressions: ${regression}, improvements: ${improvement}`)
  console.log(`  Gate: Arm A delta must be >= 0. ${regression === 0 ? 'PASSED' : 'FAILED'}`)
  const n = off.armA.n + off.armB.n
  console.log(`  Caveat: ${n} tasks total. At this size one flipped answer moves a rate by`)
  console.log('  several points, so this bounds the effect rather than establishing it.')
}

async function main() {
  const off = await runState('off', {}, 'scripts/compress/tmp/quality-off.json')
  const on = await runState('on', ON, 'scripts/compress/tmp/quality-on.json')
  report(off, on)
  if (!KEEP) {
    console.log('\n  leaving the container in the features-on state; pass --keep to stop it')
  }
}

main().catch((error) => { console.error('crashed:', error); process.exitCode = 1 })
