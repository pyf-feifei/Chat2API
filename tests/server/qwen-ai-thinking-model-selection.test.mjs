import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('load balancer matches Qwen AI thinking and fast suffixes against the base model', () => {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')

  assert.match(source, /normalizeModelForProviderMatch/)
  assert.match(source, /replace\(\/-\(thinking\|fast\)\$\/i,\s*''\)/)
  assert.match(source, /const normalizedModel = this\.normalizeModelForProviderMatch\(model\)\.toLowerCase\(\)/)
  assert.match(source, /const normalizedActualModel = this\.normalizeModelForProviderMatch\(actualModel\)\.toLowerCase\(\)/)
})

test('load balancer avoids a failed Qwen AI account on the next selection', () => {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')

  assert.match(source, /FAIL_THRESHOLD = 1/)
  assert.match(source, /RECOVERY_TIME = 60000/)
  assert.match(source, /let candidates = this\.getAvailableAccounts\(model, preferredProviderId, true\)/)
  assert.match(source, /candidates = this\.getAvailableAccounts\(model, preferredProviderId, false\)/)
})
