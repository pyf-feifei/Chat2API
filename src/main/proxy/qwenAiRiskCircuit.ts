import { createHash } from 'node:crypto'
import type { ChatCompletionRequest } from './types'
import {
  createQwenAiSessionRequestFingerprint,
  createQwenAiTranscriptHash,
} from './qwenAiSessionBridge.ts'

export interface QwenAiRiskCircuitEntry {
  fingerprint: string
  openedAt: number
  until: number
  failures: number
  lastReason: string
}

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_THRESHOLD = 2
const DEFAULT_MAX_ENTRIES = 512
const entries = new Map<string, QwenAiRiskCircuitEntry>()

function boundedEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function qwenAiRiskCircuitCooldownMs(): number {
  return boundedEnvNumber(
    'CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS',
    DEFAULT_COOLDOWN_MS,
    1_000,
    24 * 60 * 60 * 1000,
  )
}

export function qwenAiRiskCircuitThreshold(): number {
  return boundedEnvNumber(
    'CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD',
    DEFAULT_THRESHOLD,
    1,
    10,
  )
}

function maxEntries(): number {
  return boundedEnvNumber(
    'CHAT2API_QWEN_AI_RISK_CIRCUIT_MAX_ENTRIES',
    DEFAULT_MAX_ENTRIES,
    1,
    100_000,
  )
}

function prune(now: number): void {
  for (const [key, entry] of Array.from(entries.entries())) {
    if (entry.until <= now) entries.delete(key)
  }
  const limit = maxEntries()
  while (entries.size > limit) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function createQwenAiRiskFingerprint(
  request: Pick<ChatCompletionRequest, 'model' | 'messages' | 'tools' | 'tool_choice' | 'parallel_tool_calls' | 'response_format' | 'reasoning_effort' | 'enable_thinking' | 'thinking_budget' | 'image_generation' | 'stream'>,
  actualModel?: string,
  stableKey?: string,
): string {
  const contract = createQwenAiSessionRequestFingerprint(request)
  const actual = actualModel ?? request.model
  if (stableKey) {
    return createHash('sha256')
      .update(JSON.stringify({ contract, stableKey, actualModel: actual }))
      .digest('hex')
  }
  const transcript = createQwenAiTranscriptHash(request.messages)
  return createHash('sha256')
    .update(JSON.stringify({
      contract,
      transcript,
      actualModel: actual,
      stream: request.stream === true,
    }))
    .digest('hex')
}

export function getQwenAiRiskCircuitEntry(
  fingerprint: string,
  now = Date.now(),
): QwenAiRiskCircuitEntry | undefined {
  prune(now)
  const entry = entries.get(fingerprint)
  if (!entry || entry.failures < qwenAiRiskCircuitThreshold()) return undefined
  return { ...entry }
}

export function openQwenAiRiskCircuit(
  fingerprint: string,
  details: { reason?: string; now?: number } = {},
): QwenAiRiskCircuitEntry {
  const now = details.now ?? Date.now()
  prune(now)
  const previous = entries.get(fingerprint)
  const entry: QwenAiRiskCircuitEntry = {
    fingerprint,
    openedAt: now,
    until: now + qwenAiRiskCircuitCooldownMs(),
    failures: (previous?.failures ?? 0) + 1,
    lastReason: details.reason || 'qwen_ai_content_verdict',
  }
  entries.delete(fingerprint)
  entries.set(fingerprint, entry)
  prune(now)
  return { ...entry }
}

export function clearQwenAiRiskCircuit(fingerprint: string): void {
  entries.delete(fingerprint)
}

/* ------------------------------------------------------------------ *
 * Egress-level circuit
 *
 * The per-fingerprint circuit above only protects the *identical* payload
 * that was already judged. A bxpunish/RGV587 verdict, however, is usually
 * decided by the egress IP (or the task pattern), not by that one payload:
 * every other in-flight request with a different transcript keeps its own
 * fingerprint and walks a different account. That is how a single flagged
 * egress turns into a 40-request pool-wide storm -- observed 2026-09-25
 * while testing the local 340-account pool, where three 503s were produced
 * by unrelated requests racing the same blocked exit.
 *
 * This circuit is process-wide and fingerprint-agnostic: it stops new Qwen
 * work before it consumes another account, and a single success closes it.
 * ------------------------------------------------------------------ */

const DEFAULT_EGRESS_COOLDOWN_MS = 3 * 60 * 1000
// Measured 2026-09-26: a threshold of 3 tripped on an ordinary burst of
// testing, and because the verdict is usually spurious the circuit then blocked
// ALL traffic for the whole cooldown, turning a healthy pool into a total
// outage. A circuit that misfires on normal traffic is worse than no circuit:
// it only earns its keep on a sustained run of distinct verdicts.
const DEFAULT_EGRESS_THRESHOLD = 12
const DEFAULT_EGRESS_WINDOW_MS = 5 * 60 * 1000

export interface QwenAiEgressCircuitEntry {
  until: number
  openedAt: number
  verdicts: number
  distinctFingerprints: number
  lastReason: string
}

let egressEntry: QwenAiEgressCircuitEntry | undefined
let egressVerdictTimestamps: number[] = []
let egressVerdictFingerprints: { fingerprint: string; at: number }[] = []

export function qwenAiEgressCircuitCooldownMs(): number {
  return boundedEnvNumber(
    'CHAT2API_QWEN_AI_EGRESS_CIRCUIT_COOLDOWN_MS',
    DEFAULT_EGRESS_COOLDOWN_MS,
    1_000,
    24 * 60 * 60 * 1000,
  )
}

/**
 * Distinct-payload verdicts required before the whole egress is parked.
 * Set to 0 to park on the first verdict.
 */
export function qwenAiEgressCircuitThreshold(): number {
  return boundedEnvNumber(
    'CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD',
    DEFAULT_EGRESS_THRESHOLD,
    0,
    1000,
  )
}

function egressCircuitWindowMs(): number {
  return boundedEnvNumber(
    'CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS',
    DEFAULT_EGRESS_WINDOW_MS,
    1_000,
    24 * 60 * 60 * 1000,
  )
}

/**
 * Record one risk verdict. Returns the active egress circuit, or undefined
 * while the egress is still considered healthy.
 */
export function recordQwenAiEgressRiskVerdict(
  details: { fingerprint?: string; reason?: string; now?: number } = {},
): QwenAiEgressCircuitEntry | undefined {
  const now = details.now ?? Date.now()
  const windowMs = egressCircuitWindowMs()
  const threshold = qwenAiEgressCircuitThreshold()

  egressVerdictTimestamps = egressVerdictTimestamps.filter((at) => now - at <= windowMs)
  egressVerdictTimestamps.push(now)

  egressVerdictFingerprints = egressVerdictFingerprints.filter(
    (entry) => now - entry.at <= windowMs,
  )
  if (details.fingerprint
    && !egressVerdictFingerprints.some((entry) => entry.fingerprint === details.fingerprint)) {
    egressVerdictFingerprints.push({ fingerprint: details.fingerprint, at: now })
  }

  // Count distinct payloads, not raw verdicts: one request replayed across a
  // dozen accounts is a single signal, while a dozen different payloads all
  // failing is exactly the pool-wide pattern this circuit exists to stop.
  const distinctCount = egressVerdictFingerprints.length

  if (threshold > 0 && distinctCount < threshold) {
    return undefined
  }

  const until = now + qwenAiEgressCircuitCooldownMs()
  egressEntry = {
    until,
    openedAt: now,
    verdicts: egressVerdictTimestamps.length,
    distinctFingerprints: distinctCount,
    lastReason: details.reason || 'qwen_ai_content_verdict',
  }
  return { ...egressEntry }
}

/** Active egress circuit, or undefined when the egress looks healthy. */
export function getQwenAiEgressCircuitEntry(now = Date.now()): QwenAiEgressCircuitEntry | undefined {
  if (!egressEntry) return undefined
  if (egressEntry.until <= now) {
    egressEntry = undefined
    egressVerdictTimestamps = []
    egressVerdictFingerprints.length = 0
    return undefined
  }
  return { ...egressEntry }
}

/**
 * A single successful upstream response proves the egress works again, so the
 * verdict ledger is dropped. Without this the cooldown would have to expire
 * even after the operator fixed the routing.
 */
export function clearQwenAiEgressCircuit(): void {
  egressEntry = undefined
  egressVerdictTimestamps = []
  egressVerdictFingerprints.length = 0
}

/** Resets both the per-fingerprint and the egress-level ledgers. */
export function resetQwenAiRiskCircuit(): void {
  entries.clear()
  egressEntry = undefined
  egressVerdictTimestamps = []
  egressVerdictFingerprints.length = 0
}
