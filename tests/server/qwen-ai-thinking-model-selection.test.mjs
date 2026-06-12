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
