import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearQwenAiRiskCircuit,
  createQwenAiRiskFingerprint,
  getQwenAiRiskCircuitEntry,
  openQwenAiRiskCircuit,
  resetQwenAiRiskCircuit,
} from '../../src/main/proxy/qwenAiRiskCircuit.ts'

const baseRequest = {
  model: 'qwen3.8-max',
  messages: [{ role: 'user', content: 'same turn' }],
  stream: true,
}

test('risk fingerprint is stable for the same transcript and changes with content', () => {
  resetQwenAiRiskCircuit()
  const first = createQwenAiRiskFingerprint(baseRequest, 'qwen3.8-max')
  const second = createQwenAiRiskFingerprint({ ...baseRequest, messages: [...baseRequest.messages] }, 'qwen3.8-max')
  const changed = createQwenAiRiskFingerprint({
    ...baseRequest,
    messages: [{ role: 'user', content: 'changed turn' }],
  }, 'qwen3.8-max')
  assert.equal(first, second)
  assert.notEqual(first, changed)
  const stableFirst = createQwenAiRiskFingerprint(baseRequest, 'qwen3.8-max', 'stable-codex-chain')
  const stableLater = createQwenAiRiskFingerprint({
    ...baseRequest,
    messages: [...baseRequest.messages, { role: 'assistant', content: 'new tool output' }],
  }, 'qwen3.8-max', 'stable-codex-chain')
  assert.equal(stableFirst, stableLater, 'a stable Codex chain key must survive transcript growth')
  assert.notEqual(
    stableFirst,
    createQwenAiRiskFingerprint(baseRequest, 'qwen3.8-max', 'another-chain'),
  )
  resetQwenAiRiskCircuit()
})

test('risk circuit blocks only after the recovery probe and only for the matching fingerprint', () => {
  const previous = process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS
  const previousThreshold = process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD
  process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS = '1000'
  process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD = '2'
  resetQwenAiRiskCircuit()
  try {
    const fingerprint = createQwenAiRiskFingerprint(baseRequest, 'qwen3.8-max')
    const other = createQwenAiRiskFingerprint({
      ...baseRequest,
      messages: [{ role: 'user', content: 'other turn' }],
    }, 'qwen3.8-max')
    const first = openQwenAiRiskCircuit(fingerprint, { now: 10_000 })
    assert.equal(first.until, 11_000)
    assert.equal(getQwenAiRiskCircuitEntry(fingerprint, 10_999), undefined, 'the first failure leaves one fresh retry probe')
    const second = openQwenAiRiskCircuit(fingerprint, { now: 10_100 })
    assert.equal(second.failures, 2)
    assert.equal(getQwenAiRiskCircuitEntry(fingerprint, 10_999)?.fingerprint, fingerprint)
    assert.equal(getQwenAiRiskCircuitEntry(other, 10_999), undefined)
    assert.equal(getQwenAiRiskCircuitEntry(fingerprint, 11_100), undefined)
  } finally {
    resetQwenAiRiskCircuit()
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS
    else process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS = previous
    if (previousThreshold === undefined) delete process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD
    else process.env.CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD = previousThreshold
  }
})

test('a successful request can clear its fingerprint circuit', () => {
  resetQwenAiRiskCircuit()
  const fingerprint = createQwenAiRiskFingerprint(baseRequest, 'qwen3.8-max')
  openQwenAiRiskCircuit(fingerprint, { now: Date.now() })
  clearQwenAiRiskCircuit(fingerprint)
  assert.equal(getQwenAiRiskCircuitEntry(fingerprint), undefined)
})
