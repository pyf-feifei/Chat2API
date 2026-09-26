/**
 * Retrieval settings for recoverable compression.
 *
 * Parsing follows `getUpstreamTokenOptimizerSettings` exactly: every parser is
 * total, an empty string is distinguished from a valid zero, and an unknown
 * value falls back to the safe default. `CHAT2API_COMPRESS_RETRIEVAL` defaults
 * to `off`, because injecting a retrieval tool teaches the model a capability
 * that most deployments have not asked for.
 *
 * Design: `docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`
 */

import { DEFAULT_MAX_RETRIEVALS_PER_REQUEST } from './retrievalTool.ts'
import type { RetrievalSettings } from './retrievalTool.ts'

/**
 * Read a non-negative integer environment variable, treating empty and junk as
 * unset. Exported so the archive settings in `forwarder.ts` parse through the
 * same rule as every other deployment knob, rather than a second copy that can
 * drift.
 */
export function parseNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/** Read a non-negative integer from the process environment. */
export function nonNegativeEnv(key: string, fallback: number): number {
  return parseNonNegativeInteger(process.env[key], fallback)
}

function parseRetrievalFlag(raw: string | undefined): boolean {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return false
  if (['0', 'false', 'off', 'disabled', 'no'].includes(value)) return false
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(value)) return true
  // Unknown value: the feature is lossy-adjacent and opt-in, so it stays off.
  return false
}

export function getRetrievalSettings(
  env: Record<string, string | undefined> = process.env,
): RetrievalSettings {
  return {
    enabled: parseRetrievalFlag(env.CHAT2API_COMPRESS_RETRIEVAL),
    maxRetrievalsPerRequest: parseNonNegativeInteger(
      env.CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST,
      DEFAULT_MAX_RETRIEVALS_PER_REQUEST,
    ),
  }
}

export type { RetrievalSettings }
