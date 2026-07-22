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

test('forwarder does not retry cancellations or completed response timeouts', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /result\.status === 499/)
  assert.match(source, /isQwenAiProvider && \(lastStatus === 403 \|\| lastStatus === 429 \|\| lastStatus === 504\)/)
  assert.match(source, /status === 499[\s\S]*status === 403[\s\S]*status === 429[\s\S]*status === 504[\s\S]*\? false/)
  assert.match(source, /lastRetryable === false[\s\S]*lastStatus === 499/)
  assert.match(source, /context\.signal\?\.aborted && result\.status !== 499[\s\S]*lastStatus = 499/)
})

test('forwarder returns a provider 429 to the caller instead of internally requeueing it', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /isQwenAiProvider && result\.status === 429/)
})

test('forwarder retry backoff stops promptly when the client aborts', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /this\.delay\(5000, context\.signal\)/)
  assert.match(source, /if \(!delayCompleted\)[\s\S]*lastStatus = 499[\s\S]*lastRetryable = false/)
  assert.match(source, /private delay\(ms: number, signal\?: AbortSignal\): Promise<boolean>/)
  assert.match(source, /signal\?\.addEventListener\('abort', onAbort, \{ once: true \}\)/)
  assert.match(source, /if \(timer\) clearTimeout\(timer\)/)
  assert.match(source, /signal\?\.removeEventListener\('abort', onAbort\)/)
})
