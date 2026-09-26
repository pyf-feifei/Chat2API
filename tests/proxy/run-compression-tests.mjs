/**
 * Runner for the compression track's tests.
 *
 * Mirrors `tests/server/run-server-tests.mjs` so the two tracks stay
 * independent. `tests/server` is a flat directory and the server runner uses a
 * non-recursive `readdirSync`, so the compression tests would be invisible to it.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const testDir = path.resolve('tests/proxy')
const supportsNativeTypeScript = Boolean(process.features?.typescript)

function collect(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collect(full))
      continue
    }
    if (entry.name.endsWith('.test.mjs')) {
      files.push(full)
    } else if (supportsNativeTypeScript && entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

const files = collect(testDir).sort()
if (files.length === 0) {
  console.error('[compression-tests] no test files found under', testDir)
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
