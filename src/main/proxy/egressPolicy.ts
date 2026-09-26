/**
 * Egress policy: keep AI provider traffic off the local proxy.
 *
 * Why this exists
 * ---------------
 * On 2026-09-25 the local Windows host ran Clash Verge with
 * `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7897` and
 * `NO_PROXY=127.0.0.1,localhost`. `proxy-from-env` (the resolver axios uses)
 * therefore sent *every* provider request through the local proxy, including
 * Qwen. The active Clash node was a `hysteria2` endpoint on 195.242.178.82 --
 * the same box that runs the production deployment. Two consequences:
 *
 *   1. Qwen saw a shared US-datacenter egress instead of the residential IP.
 *      Aliyun WAF / bxpunish flagged it (`RGV587`, `egress-IP flag`).
 *   2. The local instance and production shared one egress IP while both drove
 *      the same ~340-account pool, which is a textbook anomaly shape.
 *
 * Root cause was NOT "the home IP is banned" -- the home IP was never used.
 *
 * How the fix works
 * -----------------
 * `proxy-from-env` reads `process.env` on *every* `getProxyForUrl()` call, so
 * appending to `NO_PROXY`/`no_proxy` at runtime is immediately effective for
 * every axios instance, including ones already constructed. This module runs
 * before the app/server bootstraps network work.
 *
 * Control
 * -------
 *   CHAT2API_EGRESS_DIRECT=off|0|false  disable entirely
 *   CHAT2API_EGRESS_DIRECT=extra-a,extra-b  replace the domain list
 *   CHAT2API_EGRESS_DIRECT_EXTRA=a.com   append to the default list
 *   CHAT2API_LOG_LEVEL                  set to `debug` for a startup line
 */

/** Domains that must always egress directly. */
export const DEFAULT_EGRESS_DIRECT_DOMAINS = [
  // Qwen AI (chat.qwen.ai) -- the provider hit by RGV587 / bxpunish.
  '.qwen.ai',
  // Qwen / Tongyi consumer chat (chat2.qianwen.com and friends).
  '.qianwen.com',
  // Aliyun DashScope + OSS, used for Qwen API keys and file uploads.
  '.aliyuncs.com',
  '.alibabacloud.com',
  '.alicdn.com',
] as const

/** Hosts that must never be proxied regardless of list configuration. */
const ALWAYS_DIRECT_HOSTS = ['127.0.0.1', 'localhost'] as const

const ENV_KEYS = ['NO_PROXY', 'no_proxy'] as const

let applied = false

function envDisabled(): boolean {
  const raw = process.env.CHAT2API_EGRESS_DIRECT
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no'
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function normalizeDomain(entry: string): string {
  const trimmed = entry.trim().toLowerCase()
  if (!trimmed || trimmed === '*') return trimmed
  // A bare host (no dot) or an IP literal must stay verbatim: NO_PROXY matches
  // "127.0.0.1" exactly, and prefixing a dot would turn it into a suffix rule
  // that never matches.
  if (!trimmed.includes('.')) return trimmed.replace(/^\.+/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(':')) return trimmed
  // Normalize a leading dot away, then re-add it so a bare "qwen.ai" and a
  // ".qwen.ai" entry both match every subdomain via NO_PROXY semantics.
  return `.${trimmed.replace(/^\.+/, '')}`
}

function resolveDomains(): string[] {
  const override = splitList(process.env.CHAT2API_EGRESS_DIRECT)
  const base = override.length > 0
    ? override
    : [...DEFAULT_EGRESS_DIRECT_DOMAINS]
  const extra = splitList(process.env.CHAT2API_EGRESS_DIRECT_EXTRA)

  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...ALWAYS_DIRECT_HOSTS, ...base, ...extra]) {
    const normalized = normalizeDomain(entry)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function mergeNoProxy(existing: string | undefined, additions: string[]): string {
  const current = splitList(existing).map((entry) => entry.toLowerCase())
  const currentSet = new Set(current)
  const merged = [...current]
  for (const entry of additions) {
    if (currentSet.has(entry)) continue
    currentSet.add(entry)
    merged.push(entry)
  }
  return merged.join(',')
}

/**
 * Append the direct-egress domains to `NO_PROXY`/`no_proxy`.
 *
 * Idempotent: repeated calls only re-apply the merge, they never duplicate
 * entries. Safe to call from both the Electron main process and the headless
 * server entry point.
 */
export function applyEgressDirectPolicy(): string[] {
  if (envDisabled()) {
    if (process.env.CHAT2API_LOG_LEVEL === 'debug') {
      console.info('[Egress] Direct-egress policy disabled by CHAT2API_EGRESS_DIRECT')
    }
    return []
  }

  const domains = resolveDomains()
  const before = { ...process.env }

  for (const key of ENV_KEYS) {
    process.env[key] = mergeNoProxy(process.env[key], domains)
  }

  applied = true

  const proxyConfigured = Boolean(
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.https_proxy,
  )
  const log = proxyConfigured
    ? `[Egress] Provider traffic forced direct. proxy=${process.env.HTTPS_PROXY || process.env.HTTP_PROXY} no_proxy=${process.env.NO_PROXY}`
    : `[Egress] Direct-egress policy applied (no proxy configured). no_proxy=${process.env.NO_PROXY}`

  if (proxyConfigured || process.env.CHAT2API_LOG_LEVEL === 'debug') {
    console.info(log)
  }

  if (proxyConfigured && process.env.CHAT2API_LOG_LEVEL === 'debug') {
    console.info(`[Egress] prev HTTP_PROXY=${before.HTTP_PROXY} HTTPS_PROXY=${before.HTTPS_PROXY}`)
  }

  return domains
}

/** Whether {@link applyEgressDirectPolicy} has run in this process. */
export function isEgressDirectPolicyApplied(): boolean {
  return applied
}

// Self-apply on import so `import './egressPolicy'` is a safe side-effect import
// and the policy lands before any later module performs network I/O. The call is
// idempotent, so entry points may also invoke it explicitly.
applyEgressDirectPolicy()
