/**
 * Working-tree monitor for concurrent edits.
 *
 * Another process is editing this repository alongside this session. The
 * compression track owns `forwarder.ts` and `src/main/proxy/services/**`; the
 * image-slimming track owns `imageSlimPolicy.ts` and `replayImageSlimming.ts`.
 * Anything else changing is not ours, and a change to something we are about to
 * touch is a conflict signal.
 *
 * Usage:
 *   node scripts/compress/watch-tree.mjs snapshot   # record the current state
 *   node scripts/compress/watch-tree.mjs diff      # report what moved since the snapshot
 *   node scripts/compress/watch-tree.mjs watch     # poll every 5s
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const statePath = path.join(repoRoot, 'scripts', 'compress', '.watch-tree-state.json')

/** Files this session owns. A change here is ours, not a conflict. */
const OWNED = [
  'src/main/proxy/forwarder.ts',
  'src/main/proxy/services',
  'src/main/proxy/imageSlimPolicy.ts',
  'src/main/proxy/replayImageSlimming.ts',
  'src/main/proxy/toolCalling/localToolCalls.ts',
  'src/main/proxy/toolCalling/ToolCallingEngine.ts',
  'src/main/proxy/toolCalling/types.ts',
  'src/main/proxy/toolCalling/runtimePlan.ts',
  'tests/proxy',
  'scripts/compress',
  'docs/superpowers',
  // Test harnesses this track edits when the forwarder gains an import.
  'tests/server/retrieval-tool-injection.test.ts',
  'tests/server/retrieval-tool-boundary.test.ts',
  'tests/server/qwen-ai-image-output.test.mjs',
  'tests/server/qwen-ai-stream-failure.test.mjs',
  'tests/server/qwen-ai-forwarder-recovery.test.mjs',
  'tests/server/qwen-ai-responses-session-bridge.test.mjs',
  'tests/server/qwen-ai-compaction-forwarder.test.mjs',
  'tests/server/qwen-ai-chat-tool-call-session.test.mjs',
  'tests/server/chat-effective-accounting.test.mjs',
  'tests/server/responses-effective-account.test.mjs',
  'tests/server/upstream-token-optimizer.test.ts',
  'tests/server/replay-slimming-and-busy-cap.test.ts',
  'tests/server/image-slim-policy.test.ts',
  'tests/server/image-slim-precedence.test.ts',
  'tests/server/image-slim-capability.test.ts',
  'tests/server/image-slim-routes.test.ts',
  'tests/server/image-slim-measurement.test.ts',
  'tests/server/image-slim-rollout.test.ts',
  'src/main/proxy/replayImageSlimming.ts',
]

function isOwned(relative) {
  return OWNED.some((prefix) => relative === prefix || relative.startsWith(prefix + '/'))
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out'
      || entry.name === 'out-server' || entry.name === 'out-admin' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile()) {
      const stat = statSync(full)
      out[path.relative(repoRoot, full).split(path.sep).join('/')] = stat.mtimeMs
    }
  }
  return out
}

function snapshot() {
  const state = walk(path.join(repoRoot, 'src'), {})
  const tests = walk(path.join(repoRoot, 'tests'), {})
  writeFileSync(statePath, JSON.stringify({ ...state, ...tests }))
  const owned = Object.keys(state).filter(isOwned).length
  console.log(`snapshot: ${Object.keys(state).length} files (${owned} owned by this session)`)
}

function diff() {
  if (!existsSync(statePath)) {
    console.error('no snapshot yet; run: node scripts/compress/watch-tree.mjs snapshot')
    process.exit(1)
  }
  const before = JSON.parse(readFileSync(statePath, 'utf8'))
  const after = { ...walk(path.join(repoRoot, 'src'), {}), ...walk(path.join(repoRoot, 'tests'), {}) }

  const added = []
  const changed = []
  const removed = []

  for (const [file, mtime] of Object.entries(after)) {
    if (!(file in before)) added.push(file)
    else if (before[file] !== mtime) changed.push(file)
  }
  for (const file of Object.keys(before)) {
    if (!(file in after)) removed.push(file)
  }

  const label = (list) => list.map((f) => `${isOwned(f) ? '[ours] ' : '[OTHER] '}${f}`)
  if (added.length) console.log(`added (${added.length}):\n  ${label(added).join('\n  ')}`)
  if (changed.length) console.log(`changed (${changed.length}):\n  ${label(changed).join('\n  ')}`)
  if (removed.length) console.log(`removed (${removed.length}):\n  ${label(removed).join('\n  ')}`)
  if (!added.length && !changed.length && !removed.length) console.log('no changes since the snapshot')

  const foreign = [...added, ...changed].filter((f) => !isOwned(f))
  console.log(foreign.length
    ? `\nCONCURRENT ACTIVITY: ${foreign.length} file(s) outside this session's ownership`
    : '\nno concurrent activity in tracked paths')
}

function watch() {
  let last = 0
  for (;;) {
    const now = Date.now()
    if (now - last > 5000) {
      last = now
      process.stdout.write(`\n[${new Date().toISOString()}] `)
      diff()
    }
  }
}

const mode = process.argv[2] || 'diff'
if (mode === 'snapshot') snapshot()
else if (mode === 'diff') diff()
else if (mode === 'watch') watch()
else {
  console.error('usage: watch-tree.mjs snapshot | diff | watch')
  process.exit(1)
}
