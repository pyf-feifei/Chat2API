/**
 * Compression settings.
 *
 * Parsing follows `getUpstreamTokenOptimizerSettings` and `getRetrievalSettings`
 * exactly: every parser is total, an empty string is distinguished from a valid
 * zero, and an unknown value falls back to the safe default rather than a guess.
 *
 * `CHAT2API_COMPRESS_BACKEND` defaults to `ts`, which is the one backend that is
 * always registered, always available, and carries no dependency. The other two
 * names are accepted so a deployment can opt in, and an unrecognized name also
 * resolves to `ts` instead of failing the request.
 *
 * Design: `docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`
 */

import { DEFAULT_MAX_RETRIEVALS_PER_REQUEST } from './retrievalTool.ts'
import type { RetrievalSettings } from './retrievalTool.ts'
import type { CompressionBackendId } from './backends/types.ts'
import { tsBackend } from './backends/tsBackend.ts'
import { getCompressionBackend } from './backends/registry.ts'

export type { RetrievalSettings }
export type { CompressionBackendId }

export type CompressionBackendMode = CompressionBackendId | 'auto'

export interface CompressionSettings {
  mode: CompressionBackendMode
  retrieval: RetrievalSettings
  /** Bounds on the CCR archive. */
  archiveTtlMs: number
  archiveMaxChars: number
}

const DEFAULT_ARCHIVE_TTL_MS = 86_400_000
const DEFAULT_ARCHIVE_MAX_CHARS = 64 * 1024 * 1024

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function parseRetrievalFlag(raw: string | undefined): boolean {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return false
  if (['0', 'false', 'off', 'disabled', 'no'].includes(value)) return false
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(value)) return true
  // Unknown value: the feature is opt-in, so it stays off.
  return false
}

function parseBackendMode(raw: string | undefined): CompressionBackendMode {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'wasm' || value === 'python' || value === 'auto') return value
  // Anything else, including `ts`, `nonsense` and empty, resolves to the
  // guaranteed backend rather than guessing at a dependency we may not have.
  return 'ts'
}

export function getCompressionSettings(
  env: Record<string, string | undefined> = process.env,
): CompressionSettings {
  return {
    mode: parseBackendMode(env.CHAT2API_COMPRESS_BACKEND),
    retrieval: {
      enabled: parseRetrievalFlag(env.CHAT2API_COMPRESS_RETRIEVAL),
      maxRetrievalsPerRequest: parseNonNegativeInteger(
        env.CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST,
        DEFAULT_MAX_RETRIEVALS_PER_REQUEST,
      ),
    },
    archiveTtlMs: parseNonNegativeInteger(
      env.CHAT2API_COMPRESS_ARCHIVE_TTL_MS,
      DEFAULT_ARCHIVE_TTL_MS,
    ),
    archiveMaxChars: parseNonNegativeInteger(
      env.CHAT2API_COMPRESS_ARCHIVE_MAX_CHARS,
      DEFAULT_ARCHIVE_MAX_CHARS,
    ),
  }
}

/**
 * Resolve the compute backend for a request.
 *
 * Never rejects and never returns a backend that cannot run. Kept here rather
 * than in the registry so a caller reads one settings module and gets both the
 * configuration and the resolved backend.
 */
export function resolveCompressionBackend(
  mode: CompressionBackendMode = 'ts',
): ReturnType<typeof getCompressionBackend> extends Promise<infer T> ? Promise<T> : never {
  return getCompressionBackend(mode)
}

export { tsBackend }
