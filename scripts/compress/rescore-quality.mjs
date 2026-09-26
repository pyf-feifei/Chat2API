/**
 * Re-score saved quality results without issuing new requests.
 *
 * Scoring is deterministic, so a scoring change can be applied to the replies
 * that were already captured. The first run used a whitespace-sensitive
 * substring match and called a reply "wrong" because the model pretty-printed
 * its JSON; the data was identical and the check was the defect.
 *
 * The result files keep the raw replies precisely so this is possible.
 *
 * Usage: node scripts/compress/rescore-quality.mjs <off.json> <on.json>
 */

import fs from 'node:fs'

const [offPath, onPath] = process.argv.slice(2)
if (!offPath || !onPath) { console.error('usage: rescore-quality.mjs <off.json> <on.json>'); process.exit(1) }

const off = JSON.parse(fs.readFileSync(offPath, 'utf8'))
const on = JSON.parse(fs.readFileSync(onPath, 'utf8'))

/**
 * Structure-insensitive comparison.
 *
 * Whitespace is collapsed before matching, so `{"a": [1, 2]}` and a
 * pretty-printed form of the same object both pass. Quoting style is not
 * normalised: a reply that answers with a different value is still wrong, and
 * the reply is kept in the result file so a human can check a failure.
 */
function matches(reply, expected) {
  // Strip ALL whitespace, not just runs. Collapsing runs leaves `[ 1, 2 ]`
  // unequal to `[1, 2]`, which is how a correct pretty-printed answer was scored
  // wrong. Quote style is normalised too; prose tasks are unaffected because
  // their expected values are short literals like "623" or "PROXY".
  const normalise = (value) => String(value || '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/\s+/g, '')
  return normalise(reply).includes(normalise(expected))
}

function score(results) {
  const armA = results.filter((r) => r.arm === 'A')
  const armB = results.filter((r) => r.arm === 'B')
  return {
    armA: { n: armA.length, pass: armA.filter((r) => r.ok && matches(r.reply, r.expect)).length },
    armB: { n: armB.length, pass: armB.filter((r) => r.ok && matches(r.reply, r.expect)).length },
  }
}

const sOff = score(off.results)
const sOn = score(on.results)
const byId = new Map(off.results.map((r) => [r.id, r]))

console.log('='.repeat(72))
console.log('QUALITY, RE-SCORED (whitespace-insensitive, no new requests)')
console.log('='.repeat(72))
console.log('  task          arm  off   on    verdict')
let regression = 0
let improvement = 0
for (const b of on.results) {
  const a = byId.get(b.id)
  if (!a) continue
  const aPass = a.ok && matches(a.reply, a.expect)
  const bPass = b.ok && matches(b.reply, b.expect)
  const verdict = aPass === bPass
    ? (aPass ? 'same ok' : 'same wrong')
    : (bPass ? 'IMPROVED' : 'REGRESSION')
  if (verdict === 'REGRESSION') regression += 1
  if (verdict === 'IMPROVED') improvement += 1
  console.log(`  ${b.id.padEnd(13)} ${b.arm}    ${String(aPass).padEnd(5)} ${String(bPass).padEnd(5)} ${verdict}`)
  if (aPass !== bPass) {
    console.log(`      off -> ${JSON.stringify(a.reply.slice(0, 70))}`)
    console.log(`      on  -> ${JSON.stringify(b.reply.slice(0, 70))}`)
  }
}
const dA = sOn.armA.n ? (100 * (sOn.armA.pass - sOff.armA.pass)) / sOff.armA.n : 0
const dB = sOn.armB.n ? (100 * (sOn.armB.pass - sOff.armB.pass)) / sOff.armB.n : 0
console.log('-'.repeat(72))
console.log(`  Arm A regression  off ${sOff.armA.pass}/${sOff.armA.n}  on ${sOn.armA.pass}/${sOn.armA.n}`
  + `   delta ${dA >= 0 ? '+' : ''}${dA.toFixed(1)} pp`)
if (sOff.armB.n === 0) {
  console.log('  Arm B tradeoff    NOT MEASURED (the run was capped before arm B)')
} else {
  console.log(`  Arm B tradeoff    off ${sOff.armB.pass}/${sOff.armB.n}  on ${sOn.armB.pass}/${sOn.armB.n}`
    + `   delta ${dB >= 0 ? '+' : ''}${dB.toFixed(1)} pp`)
}
console.log('='.repeat(72))
console.log(`\n  regressions ${regression}, improvements ${improvement}`)
console.log(`  Gate: Arm A delta >= 0. ${regression === 0 ? 'PASSED' : 'FAILED'}`)
const total = sOff.armA.n + sOff.armB.n
console.log(`  Caveat: ${total} tasks. One flipped answer moves a rate by ~${(100 / Math.max(sOff.armA.n, 1)).toFixed(0)} pp,`)
console.log('  so this bounds the effect rather than establishing it.')
