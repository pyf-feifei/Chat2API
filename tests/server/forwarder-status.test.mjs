import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('forwarder preserves provider error status after retry loop', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /let lastStatus: number \| undefined/)
  assert.match(source, /lastStatus = result\.status/)
  assert.match(source, /lastStatus = statusFromError\(error\)/)
  assert.match(source, /status: lastStatus/)
})
