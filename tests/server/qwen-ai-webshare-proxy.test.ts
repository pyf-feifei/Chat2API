import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isWebshareProxyEnabled,
  isWebshareStickyActive,
  getWebshareProxyAgent,
  setWebshareProxyConfig,
  webshareProxyConfigSnapshot,
  websharePoolSnapshot,
  webshareStickySnapshot,
  engageWebshareStickyMode,
  disengageWebshareStickyMode,
  resetWebshareStickyState,
  reportWebshareProxyFailure,
  reportWebshareProxySuccess,
  reportWebshareKeyBandwidthExhausted,
  checkoutWebshareProxyAgent,
  webshareProxyUrlForLog,
} from '../../src/main/proxy/webshareProxy.ts'

const ENV_KEYS = [
  'WEBSHARE_PROXY_ENABLED',
  'WEBSHARE_PROXY_URL',
  'CHAT2API_WEBSHARE_PROXY_ENABLED',
  'CHAT2API_WEBSHARE_PROXY_URL',
]

function clearWebshareEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

function clearRuntimeConfig(): void {
  setWebshareProxyConfig(undefined)
  resetWebshareStickyState()
}

function lastUsedIndex(): number {
  const snapshot = websharePoolSnapshot()
  let latest = -1
  let latestAt = -1
  snapshot.forEach((entry, index) => {
    if ((entry.lastUsed ?? 0) > latestAt) {
      latestAt = entry.lastUsed ?? 0
      latest = index
    }
  })
  return latest
}

test('webshare proxy stays disabled unless flag and URL are both present', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  assert.equal(isWebshareProxyEnabled(), false)
  assert.equal(getWebshareProxyAgent(), undefined)
  assert.equal(webshareProxyUrlForLog(), undefined)

  process.env.WEBSHARE_PROXY_ENABLED = 'true'
  assert.equal(isWebshareProxyEnabled(), false, 'flag without URL must stay disabled')

  process.env.WEBSHARE_PROXY_URL = 'http://user:pass@proxy.webshare.io:8080'
  assert.equal(isWebshareProxyEnabled(), true)
  clearWebshareEnv()
})

test('webshare proxy agent is cached per proxy URL', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  process.env.WEBSHARE_PROXY_ENABLED = '1'
  process.env.WEBSHARE_PROXY_URL = 'http://user:pass@proxy.webshare.io:8080'
  const agent = getWebshareProxyAgent()
  assert.ok(agent)
  assert.equal(getWebshareProxyAgent(), agent)
  clearWebshareEnv()
})

test('webshare proxy log URL shows credentials', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  process.env.WEBSHARE_PROXY_URL = 'http://user:secret@proxy.webshare.io:8080'
  const logged = webshareProxyUrlForLog()
  assert.ok(logged)
  assert.ok(logged.includes('secret'))
  assert.ok(logged.includes('proxy.webshare.io:8080'))
  clearWebshareEnv()
})

test('webshare key-as-username is shown in log URL', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  process.env.WEBSHARE_PROXY_ENABLED = 'true'
  process.env.WEBSHARE_PROXY_URL = 'http://zsv6keyexample:@proxy.webshare.io:8080'
  const logged = webshareProxyUrlForLog() ?? ''
  assert.ok(logged.includes('zsv6keyexample'), 'the key should appear in the log URL')
  clearWebshareEnv()
})

test('CHAT2API-prefixed webshare variables take precedence', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  process.env.CHAT2API_WEBSHARE_PROXY_ENABLED = 'true'
  process.env.CHAT2API_WEBSHARE_PROXY_URL = 'http://u:p@proxy.example:80'
  assert.equal(isWebshareProxyEnabled(), true)
  assert.ok(getWebshareProxyAgent())
  clearWebshareEnv()
})

test('runtime config from the management UI overrides env and applies immediately', () => {
  clearWebshareEnv()
  clearRuntimeConfig()

  // env still enabled — runtime config disabled must win over enabled env
  process.env.WEBSHARE_PROXY_ENABLED = 'true'
  process.env.WEBSHARE_PROXY_URL = 'http://env-user:env-pass@proxy.env.example:8080'
  setWebshareProxyConfig({ enabled: false, proxyUrl: 'http://ui-user:ui-pass@proxy.ui.example:8080' })
  assert.equal(isWebshareProxyEnabled(), false, 'disabled runtime config must override enabled env')
  assert.equal(getWebshareProxyAgent(), undefined, 'disabled runtime config must not produce an agent')

  // enabling the runtime config applies without any env set
  setWebshareProxyConfig({ enabled: true, proxyUrl: 'http://ui-user:ui-pass@proxy.ui.example:8080' })
  assert.equal(isWebshareProxyEnabled(), true)
  const logged = webshareProxyUrlForLog() ?? ''
  assert.ok(logged.includes('proxy.ui.example:8080'), 'runtime URL must be used')
  assert.ok(logged.includes('ui-pass'), 'runtime credentials should be shown in logs')

  // snapshot reflects the runtime config
  const snapshot = webshareProxyConfigSnapshot()
  assert.deepEqual(snapshot, { enabled: true, proxyUrl: 'http://ui-user:ui-pass@proxy.ui.example:8080' })

  // clearing runtime config falls back to env
  setWebshareProxyConfig(undefined)
  assert.equal(isWebshareProxyEnabled(), true)
  assert.ok((webshareProxyUrlForLog() ?? '').includes('proxy.env.example:8080'))

  clearWebshareEnv()
  clearRuntimeConfig()
})

test('enabled runtime config without a URL stays disabled', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig({ enabled: true, proxyUrl: '   ' })
  assert.equal(isWebshareProxyEnabled(), false)
  assert.equal(getWebshareProxyAgent(), undefined)
  clearRuntimeConfig()
})

test('key pool takes precedence over the single URL and rotates round-robin', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: 'http://single:single@proxy.single.example:8080' },
    [
      { proxyUrl: 'http://key1:@proxy.webshare.io:8080', enabled: true },
      { proxyUrl: 'http://key2:@proxy.webshare.io:8080', enabled: true },
      { proxyUrl: 'http://key3:@proxy.webshare.io:8080', enabled: true },
    ],
    'round-robin',
  )
  assert.equal(isWebshareProxyEnabled(), true)

  // webshareProxyUrlForLog is read-only: it must NOT advance rotation. The
  // observable consumption is the agent pull (what a real request does).
  const previewBefore = webshareProxyUrlForLog()
  const previewAgain = webshareProxyUrlForLog()
  assert.equal(previewBefore, previewAgain, 'status preview must not consume rotation')

  // Redacted URLs are identical across keys, so observe rotation through
  // the pool snapshot's lastUsed stamps: each agent pull marks its entry.
  const usedIndexes: number[] = []
  for (let i = 0; i < 6; i += 1) {
    assert.ok(getWebshareProxyAgent(), 'each pull hands an agent')
    usedIndexes.push(lastUsedIndex())
  }
  const distinct = new Set(usedIndexes)
  assert.equal(distinct.size, 3, 'three keys must rotate across six pulls')
  assert.deepEqual(usedIndexes, [0, 1, 2, 0, 1, 2], 'round-robin repeats its cycle')
  // The read-only preview still shows a redacted pool URL after consumption.
  assert.ok((webshareProxyUrlForLog() ?? '').startsWith('http://'), 'pool exits should show actual URLs')
  clearRuntimeConfig()
})

test('pool failure cools the used key and moves traffic to the next one', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://key1:@proxy.webshare.io:8080' },
      { proxyUrl: 'http://key2:@proxy.webshare.io:8080' },
    ],
    'failover',
  )

  // failover sticks to key1 first (a real agent pull consumes it)
  assert.ok(getWebshareProxyAgent(), 'failover hands the first healthy exit')
  assert.equal(lastUsedIndex(), 0, 'failover must prefer the first entry')

  // failure cools the used entry (60s base), next pull must be the other key
  reportWebshareProxyFailure()
  const snapshotAfterFailure = websharePoolSnapshot()
  assert.equal(snapshotAfterFailure[0].failureCount, 1)
  assert.ok(snapshotAfterFailure[0].cooldownUntil > Date.now(), 'first entry must be cooling')

  assert.ok(getWebshareProxyAgent(), 'a cooling pool still hands an exit')
  assert.equal(lastUsedIndex(), 1, 'cooling entry must be skipped')

  // success on the second entry clears its failure state
  reportWebshareProxySuccess()
  const snapshotAfterSuccess = websharePoolSnapshot()
  assert.equal(snapshotAfterSuccess[1].failureCount, 0)
  assert.equal(snapshotAfterSuccess[1].cooldownUntil, 0)
  assert.ok(snapshotAfterSuccess[1].lastUsed && snapshotAfterSuccess[1].lastUsed! > 0)

  // the cooling first entry expires: failover returns to it after cooldown
  // (simulated by re-applying the pool with an expired cooldown)
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://key1:@proxy.webshare.io:8080', cooldownUntil: Date.now() - 1000 },
      { proxyUrl: 'http://key2:@proxy.webshare.io:8080' },
    ],
    'failover',
  )
  webshareProxyUrlForLog()
  assert.equal(lastUsedIndex(), 0, 'expired cooldown restores the preferred entry')
  clearRuntimeConfig()
})

test('consecutive failures double the cooldown', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [{ proxyUrl: 'http://key1:@proxy.webshare.io:8080' }, { proxyUrl: 'http://key2:@proxy.webshare.io:8080' }],
    'round-robin',
  )
  reportWebshareProxyFailure()
  const first = websharePoolSnapshot()[0]
  const firstCooldown = first.cooldownUntil - Date.now()
  reportWebshareProxyFailure(first.proxyUrl)
  const second = websharePoolSnapshot()[0]
  const secondCooldown = second.cooldownUntil - Date.now()
  assert.ok(secondCooldown > firstCooldown, 'second failure must cool longer (doubling backoff)')
  clearRuntimeConfig()
})

test('all entries cooling still returns an exit rather than none', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [{ proxyUrl: 'http://key1:@proxy.webshare.io:8080' }],
    'round-robin',
  )
  reportWebshareProxyFailure()
  // single-entry pool fully cooling must not disable recovery entirely
  assert.equal(isWebshareProxyEnabled(), true)
  assert.ok(getWebshareProxyAgent(), 'a cooling pool still hands out its only exit')
  clearRuntimeConfig()
})

test('bandwidth 402 cools every exit of the drained key and leaves other keys alone', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://a1:@pool.example:1001', sourceKeyId: 'key-A' },
      { proxyUrl: 'http://a2:@pool.example:1002', sourceKeyId: 'key-A' },
      { proxyUrl: 'http://b1:@pool.example:2001', sourceKeyId: 'key-B' },
      { proxyUrl: 'http://manual:@pool.example:3001' },
    ],
    'round-robin',
  )

  reportWebshareKeyBandwidthExhausted('http://a2:@pool.example:1002')
  const snapshot = websharePoolSnapshot()
  assert.equal(snapshot[1].failureCount, 1, 'the reported exit must be cooled')
  assert.ok(snapshot[1].cooldownUntil > Date.now())
  assert.equal(snapshot[0].failureCount, 1, 'sibling exit of the same key must cool too')
  assert.ok(snapshot[0].cooldownUntil > Date.now())
  assert.equal(snapshot[2].failureCount, 0, 'other keys must stay healthy')
  assert.equal(snapshot[2].cooldownUntil, 0)
  assert.equal(snapshot[3].failureCount, 0, 'unkeyed exits must stay healthy')
  assert.equal(snapshot[3].cooldownUntil, 0)

  // rotation must skip the whole drained key, not just the reported exit
  const next = checkoutWebshareProxyAgent()
  assert.ok(next, 'healthy exits remain available')
  assert.notEqual(next!.proxyUrl, 'http://a1:@pool.example:1001')
  assert.notEqual(next!.proxyUrl, 'http://a2:@pool.example:1002')
  clearRuntimeConfig()
})

test('runtime pool preserves sourceKeyId and checkout returns the selected exit', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://a1:@pool.example:1001', sourceKeyId: 'key-A' },
      { proxyUrl: 'http://b1:@pool.example:2001', sourceKeyId: 'key-B' },
    ],
    'round-robin',
  )
  const snapshot = websharePoolSnapshot()
  assert.equal(snapshot[0].sourceKeyId, 'key-A', 'key ownership must reach the runtime pool')
  assert.equal(snapshot[1].sourceKeyId, 'key-B')

  const checkout = checkoutWebshareProxyAgent()
  assert.ok(checkout, 'checkout hands an agent when the pool is enabled')
  assert.equal(checkout!.proxyUrl, 'http://a1:@pool.example:1001')
  assert.equal(lastUsedIndex(), 0, 'checkout stamps last-used on the selected exit')
  clearRuntimeConfig()
})

test('disabled pool entries are skipped by rotation', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://key1:@proxy.webshare.io:8080', enabled: false },
      { proxyUrl: 'http://key2:@proxy.webshare.io:8080' },
    ],
    'round-robin',
  )
  const exits = new Set<string>()
  for (let i = 0; i < 4; i += 1) exits.add(webshareProxyUrlForLog() ?? '')
  assert.equal(exits.size, 1, 'only the enabled entry must serve')
  clearRuntimeConfig()
})

// ---------------------------------------------------------------------------
// Sticky mode (mode B)
// ---------------------------------------------------------------------------

test('sticky mode engages on demand and reports its snapshot', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: 'http://sticky-key:@proxy.webshare.io:8080' },
  )
  assert.equal(isWebshareStickyActive(), false, 'sticky starts inactive')

  engageWebshareStickyMode('proxy recovery succeeded after direct RGV587')
  assert.equal(isWebshareStickyActive(), true)
  const snapshot = webshareStickySnapshot()
  assert.equal(snapshot.active, true)
  assert.equal(snapshot.reason, 'proxy recovery succeeded after direct RGV587')
  assert.ok(snapshot.since > 0)
  assert.equal(snapshot.passedProbes, 0)
  assert.ok(snapshot.nextProbeAt > Date.now(), 'first direct probe is scheduled ahead')

  // Re-engaging refreshes the timestamp but keeps it idempotent (still active).
  const before = snapshot.since
  engageWebshareStickyMode('second trigger')
  assert.equal(webshareStickySnapshot().reason, 'second trigger')
  assert.ok(webshareStickySnapshot().since >= before)

  disengageWebshareStickyMode('test cleanup')
  assert.equal(isWebshareStickyActive(), false)
  assert.equal(webshareStickySnapshot().active, false)
  assert.equal(webshareStickySnapshot().reason, '')
  clearRuntimeConfig()
})

test('sticky mode requires the proxy config to stay enabled', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  // No config at all: engaging is recorded but traffic does not switch,
  // because there is no proxy exit to route through.
  engageWebshareStickyMode('nothing configured')
  assert.equal(isWebshareStickyActive(), false, 'sticky without an enabled proxy is a no-op for traffic')
  resetWebshareStickyState()

  // With the proxy enabled the same engage flips traffic.
  setWebshareProxyConfig({ enabled: true, proxyUrl: 'http://sticky-key:@proxy.webshare.io:8080' })
  engageWebshareStickyMode('risk control confirmed')
  assert.equal(isWebshareStickyActive(), true)

  // Disabling the proxy config defuses sticky mode too (no exit to use).
  setWebshareProxyConfig({ enabled: false, proxyUrl: 'http://sticky-key:@proxy.webshare.io:8080' })
  assert.equal(isWebshareStickyActive(), false, 'disabling the proxy defuses sticky routing')
  resetWebshareStickyState()
  clearRuntimeConfig()
})

test('sticky mode keeps rotating the pool for every pull', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://key1:@proxy.webshare.io:8080' },
      { proxyUrl: 'http://key2:@proxy.webshare.io:8080' },
      { proxyUrl: 'http://key3:@proxy.webshare.io:8080' },
    ],
    'round-robin',
  )
  engageWebshareStickyMode('risk control confirmed')

  // Sticky traffic pulls exits like any other proxy use: full rotation.
  const usedIndexes: number[] = []
  for (let i = 0; i < 6; i += 1) {
    assert.ok(getWebshareProxyAgent(), 'sticky mode must always hand an agent')
    usedIndexes.push(lastUsedIndex())
  }
  assert.deepEqual(usedIndexes, [0, 1, 2, 0, 1, 2], 'sticky traffic rotates the whole pool')
  resetWebshareStickyState()
  clearRuntimeConfig()
})

test('sticky failures cool entries exactly like recovery failures', () => {
  clearWebshareEnv()
  clearRuntimeConfig()
  setWebshareProxyConfig(
    { enabled: true, proxyUrl: '' },
    [
      { proxyUrl: 'http://key1:@proxy.webshare.io:8080' },
      { proxyUrl: 'http://key2:@proxy.webshare.io:8080' },
    ],
    'failover',
  )
  engageWebshareStickyMode('risk control confirmed')

  // First pull uses key1 (failover sticks to the first healthy entry).
  assert.ok(getWebshareProxyAgent(), 'sticky hands the first healthy exit')
  assert.equal(lastUsedIndex(), 0)

  reportWebshareProxyFailure()
  const snapshot = websharePoolSnapshot()
  assert.equal(snapshot[0].failureCount, 1)
  assert.ok(snapshot[0].cooldownUntil > Date.now(), 'sticky failure cools the used exit')

  // Next pull must move to key2 while key1 cools.
  assert.ok(getWebshareProxyAgent(), 'sticky still hands an exit after a failure')
  assert.equal(lastUsedIndex(), 1, 'sticky traffic moves to the next exit after a failure')

  resetWebshareStickyState()
  clearRuntimeConfig()
})
