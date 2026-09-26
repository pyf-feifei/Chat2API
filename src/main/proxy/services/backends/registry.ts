/**
 * Backend registry and selection.
 *
 * Selection never fails. `ts` is always registered, always available, and
 * carries no dependency, so every configuration has a working backend. An
 * unavailable or broken backend degrades to `ts` and logs once per process, not
 * once per request.
 *
 * Design: `docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`
 */

import { tsBackend } from './tsBackend.ts'
import type { CompressionBackend, CompressionBackendId } from './types.ts'

export type CompressionBackendMode = CompressionBackendId | 'auto'

/** The order `auto` tries. `ts` is last because it is the guaranteed floor. */
const AUTO_ORDER: CompressionBackendId[] = ['wasm', 'python', 'ts']

const registry = new Map<CompressionBackendId, CompressionBackend>([['ts', tsBackend]])

const reportedFallbacks = new Set<string>()

/**
 * Register or unregister a backend. Test-only in practice: the shipping set is
 * `ts` plus whatever the optional adapters install.
 */
export function registerCompressionBackend(
  backend: CompressionBackend | undefined,
  options: { id?: CompressionBackendId; force?: boolean } = {},
): void {
  const id = options.id ?? backend?.id
  if (!id) return
  if (backend) {
    registry.set(id, backend)
    return
  }
  // `ts` is the floor and is never removable.
  if (id === 'ts' && !options.force) return
  registry.delete(id)
}

function parseMode(raw: string): CompressionBackendMode {
  const value = raw.trim().toLowerCase()
  if (value === 'wasm' || value === 'python' || value === 'ts' || value === 'auto') return value
  // Unknown value falls back to the guaranteed backend rather than guessing.
  return 'ts'
}

async function isUsable(backend: CompressionBackend | undefined): Promise<boolean> {
  if (!backend) return false
  try {
    return await backend.available()
  } catch {
    // A backend that cannot even report availability is not usable.
    return false
  }
}

/**
 * Resolve the backend for a request.
 *
 * Never rejects and never returns a backend that cannot run. The fallback reason
 * is logged once per process per pair, because a per-request log line here would
 * be noise on every single call.
 */
export async function getCompressionBackend(
  mode: CompressionBackendMode = 'ts',
): Promise<CompressionBackend> {
  const resolved = parseMode(String(mode ?? 'ts'))

  if (resolved === 'ts') return tsBackend
  if (resolved !== 'auto') {
    const backend = registry.get(resolved)
    if (await isUsable(backend)) return backend!
    reportFallback(resolved, 'unavailable')
    return tsBackend
  }

  for (const id of AUTO_ORDER) {
    const backend = registry.get(id)
    if (await isUsable(backend)) return backend!
  }
  return tsBackend
}

function reportFallback(requested: string, reason: string): void {
  const key = `${requested}:${reason}`
  if (reportedFallbacks.has(key)) return
  reportedFallbacks.add(key)
  console.warn(
    `[CompressionBackend] ${requested} is ${reason}; falling back to ts`,
    JSON.stringify({ requested, reason }),
  )
}

/** Test-only: forget which fallbacks have already been reported. */
export function resetBackendFallbackReports(): void {
  reportedFallbacks.clear()
}
