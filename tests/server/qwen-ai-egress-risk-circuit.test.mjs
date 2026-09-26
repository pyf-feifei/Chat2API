import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

/**
 * The circuit keeps module-level state, so load a fresh copy of the module for
 * every test. The session-bridge dependency is only used by the fingerprint
 * helper, so it is stubbed out and the circuit logic is bundled on its own.
 */
async function loadCircuit() {
  const entry = path.join(repoRoot, 'src', 'main', 'proxy', 'qwenAiRiskCircuit.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-circuit-'))
  const outfile = path.join(dir, 'circuit.mjs')

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    plugins: [{
      name: 'stub-session-bridge',
      setup(build) {
        build.onResolve({ filter: /qwenAiSessionBridge/ }, () => ({
          path: 'qwenAiSessionBridge',
          namespace: 'stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: [
            'export const createQwenAiSessionRequestFingerprint = () => "";',
            'export const createQwenAiTranscriptHash = () => "";',
          ].join('\n'),
          loader: 'js',
        }))
      },
    }],
  })

  return import('file:///' + outfile.replace(/\\/g, '/'))
}

describe('qwen ai egress risk circuit', () => {
  let circuit
  const savedEnv = { ...process.env }

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CHAT2API_QWEN_AI_EGRESS_CIRCUIT') || key.startsWith('CHAT2API_QWEN_AI_RISK_CIRCUIT')) {
        delete process.env[key]
      }
    }
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('stays closed below the distinct-payload threshold', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '3'
    const t0 = 1_000_000

    assert.equal(
      circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 }),
      undefined,
      'first verdict must not park the egress',
    )
    assert.equal(
      circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-b', now: t0 + 1 }),
      undefined,
      'second distinct verdict must not park the egress',
    )
    assert.equal(circuit.getQwenAiEgressCircuitEntry(t0 + 2), undefined)
  })

  it('opens once distinct payloads hit the threshold', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '3'
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_COOLDOWN_MS = '600000'
    const t0 = 2_000_000

    circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 })
    circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-b', now: t0 + 1 })
    const opened = circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-c', now: t0 + 2 })

    assert.ok(opened, 'third distinct payload must open the circuit')
    assert.equal(opened.distinctFingerprints, 3)
    assert.equal(opened.until, t0 + 2 + 600000)
    assert.equal(opened.lastReason, 'qwen_ai_content_verdict')

    const active = circuit.getQwenAiEgressCircuitEntry(t0 + 3)
    assert.ok(active, 'circuit must be readable while parked')
  })

  it('does not count one payload replayed across accounts as distinct', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '3'
    const t0 = 3_000_000

    // Same request, different accounts -> same fingerprint.
    for (let i = 0; i < 10; i += 1) {
      const r = circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'same-fp', now: t0 + i })
      assert.equal(r, undefined, 'replays of one payload must not park the egress')
    }
    assert.equal(circuit.getQwenAiEgressCircuitEntry(t0 + 11), undefined)
  })

  it('expires the cooldown and forgets the ledger', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '2'
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_COOLDOWN_MS = '5000'
    const t0 = 4_000_000

    // Two distinct payloads are required before the egress parks.
    assert.equal(circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 }), undefined)
    const opened = circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-b', now: t0 + 1 })
    assert.ok(opened)
    assert.equal(opened.until, t0 + 1 + 5000)

    assert.ok(circuit.getQwenAiEgressCircuitEntry(t0 + 4999), 'still inside cooldown')
    assert.equal(circuit.getQwenAiEgressCircuitEntry(t0 + 5002), undefined, 'cooldown must expire')

    // The verdict ledger is dropped on expiry, so a single fresh verdict is
    // not enough to re-trip even though two distinct ones were seen before.
    assert.equal(
      circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-z', now: t0 + 6000 }),
      undefined,
      'expired ledger must not combine with a new verdict',
    )
    assert.ok(
      circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-y', now: t0 + 6001 }),
      'two fresh distinct verdicts must re-open the circuit',
    )
  })

  it('is closed by a single success', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '1'
    const t0 = 5_000_000

    assert.ok(circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 }))
    assert.ok(circuit.getQwenAiEgressCircuitEntry(t0 + 1))

    circuit.clearQwenAiEgressCircuit()
    assert.equal(circuit.getQwenAiEgressCircuitEntry(t0 + 2), undefined)
  })

  it('parks on the first verdict when the threshold is 0', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '0'
    const t0 = 6_000_000
    const opened = circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 })
    assert.ok(opened, 'threshold 0 means park immediately')
  })

  it('resets both the per-fingerprint and the egress ledger', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '1'
    const t0 = 7_000_000

    circuit.openQwenAiRiskCircuit('fp-a', { now: t0 })
    circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 })
    assert.ok(circuit.getQwenAiEgressCircuitEntry(t0 + 1))

    circuit.resetQwenAiRiskCircuit()
    assert.equal(circuit.getQwenAiEgressCircuitEntry(t0 + 2), undefined)
  })

  it('drops verdicts that fall outside the observation window', async () => {
    circuit = await loadCircuit()
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD = '3'
    process.env.CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS = '10000'
    const t0 = 8_000_000

    circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-a', now: t0 })
    circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-b', now: t0 + 1 })
    // A third verdict well after the window must not combine with the old two.
    const r = circuit.recordQwenAiEgressRiskVerdict({ fingerprint: 'fp-c', now: t0 + 60_000 })
    assert.equal(r, undefined, 'stale verdicts must not accumulate into a trip')
  })
})
