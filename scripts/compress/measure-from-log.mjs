/**
 * Measure the saving from a live container's own log, correlated by request.
 *
 * Two problems this exists to solve:
 *
 *   1. The proxy only logs the optimizer when it is enabled, so the features-off
 *      baseline has to come from somewhere else. It does not need to: the
 *      optimizer's `before` IS the unmodified size, because image slimming runs
 *      in the route ahead of it and balanced mode does not change the request
 *      before measuring. So `before` is the baseline and `after` is the result.
 *
 *   2. The container is shared. Another agent was sending traffic through the
 *      same port during the first attempts, and summing every optimizer line
 *      produced a saving LARGER than the corpus, which is physically impossible.
 *      A sanity check caught it. The fix is to join each optimizer line to the
 *      request that produced it via `requestId` and keep only the message
 *      counts this corpus actually contains.
 *
 * Usage: node scripts/compress/measure-from-log.mjs <corpus.json>
 */

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const CORPUS = process.argv[2] || 'scripts/compress/tmp/corpus.json'
const CONTAINER = process.argv[3] || 'chat2api'

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'))
const wanted = new Set(corpus.map((request) => (request.messages || []).length))

const out = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const log = out.stdout || ''

/** requestId -> messageCount, from the forwarder's own intent line. */
const counts = new Map()
for (const match of log.matchAll(/\[Forwarder\] request-intent (\{.*?\})\s*$/gm)) {
  try {
    const payload = JSON.parse(match[1])
    if (payload.requestId && typeof payload.messageCount === 'number') {
      counts.set(payload.requestId, payload.messageCount)
    }
  } catch { /* not a measurement line */ }
}

const rows = []
let foreign = 0
for (const match of log.matchAll(/\[Forwarder\] upstream-token-optimizer (\{.*?\})\s*$/gm)) {
  let payload
  try { payload = JSON.parse(match[1]) } catch { continue }
  const messageCount = counts.get(payload.requestId)
  if (!messageCount || !wanted.has(messageCount)) { foreign += 1; continue }
  rows.push(payload)
}

const slimRows = []
for (const match of log.matchAll(/\[ChatSlim\] replay image slimming (\{.*?\})\s*$/gm)) {
  let payload
  try { payload = JSON.parse(match[1]) } catch { continue }
  if (counts.get(payload.requestId) && wanted.has(counts.get(payload.requestId))) slimRows.push(payload)
}

const sum = (list, field) => list.reduce((total, item) => total + (typeof item[field] === 'number' ? item[field] : 0), 0)

const before = sum(rows, 'before')
const after = sum(rows, 'after')
const saved = sum(rows, 'estimatedSaved')
const archived = sum(rows, 'archivedChars')
const imageChars = sum(slimRows, 'imageCharsSlimmed')
const imageMessages = sum(slimRows, 'imageMessagesSlimmed')

console.log(`corpus requests: ${corpus.length}, message counts: ${[...wanted].sort((a, b) => a - b).join(', ')}`)
console.log(`optimizer lines kept: ${rows.length}, discarded as foreign: ${foreign}`)
console.log(`image slim lines kept: ${slimRows.length}\n`)

console.log('  per request:')
for (const row of rows) {
  const pct = row.before > 0 ? (100 * (row.estimatedSaved || 0) / row.before).toFixed(1) : '0.0'
  console.log(`    before ${String(row.before).padStart(9)}  after ${String(row.after).padStart(9)}`
    + `  saved ${String(row.estimatedSaved).padStart(9)}  (${pct}%)`
    + `  ceiling=${row.liveZoneCeiling}${row.skipReason ? `  skip=${row.skipReason}` : ''}`)
}

console.log('')
console.log(`  image messages slimmed : ${imageMessages}`)
console.log(`  image characters dropped: ${imageChars.toLocaleString()}`)
console.log(`  characters archived (CCR): ${archived.toLocaleString()}`)
console.log('')
console.log(`  baseline (optimizer before): ${before.toLocaleString()}`)
console.log(`  actually sent (after)      : ${after.toLocaleString()}`)
console.log(`  saved                     : ${(before - after).toLocaleString()}`)
console.log(`  reduction                 : ${before > 0 ? (100 * (before - after) / before).toFixed(1) : 'n/a'}%`)

if (rows.length !== corpus.length) {
  console.log(`\n  NOTE: kept ${rows.length} of ${corpus.length} requests. Some may still be in flight;`)
  console.log('  the totals above cover only the correlated lines.')
}
if (after > before) {
  console.log('\n  WARNING: sent more than the baseline. This run is not usable.')
}
