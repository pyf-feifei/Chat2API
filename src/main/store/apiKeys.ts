/**
 * API key value generation, display masking, and masked-value detection.
 *
 * These three rules are the reason this module exists. They must agree across
 * every writer (IPC handlers, the management routes, the config store), because
 * a disagreement is what turns a display value into a destroyed credential:
 *
 *  1. A real key is `sk-` + 48 alphanumerics (renderer generator) or `sk-mgmt-`
 *     + 32 hex (this module). Neither alphabet contains `*` or `.`.
 *  2. Every read path masks a key before it leaves the process.
 *  3. A client therefore only ever holds masked values, so it must never write
 *     a key value back. Per-key operations read the stored array instead.
 */

export const API_KEY_PREFIX = 'sk-mgmt-'
export const KEY_RANDOM_LENGTH = 32

/**
 * Generate a new API key value.
 * Format: sk-mgmt-{random hex}
 */
export function generateApiKeyValue(): string {
  const randomBytes = new Uint8Array(KEY_RANDOM_LENGTH)
  crypto.getRandomValues(randomBytes)
  const randomString = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, KEY_RANDOM_LENGTH)
  return `${API_KEY_PREFIX}${randomString}`
}

/**
 * Mask a key for display, keeping the last 8 characters.
 * This is what `GET /v0/management/api-keys` returns.
 */
export function maskApiKeyValue(key: string): string {
  return key.length > 8 ? `${API_KEY_PREFIX}...${key.slice(-8)}` : `${API_KEY_PREFIX}...`
}

/**
 * Detect an API key value that is a DISPLAY mask rather than a real key.
 *
 * `GET /v0/management/config` replaces keys with `***`; `GET /api-keys` returns
 * `sk-mgmt-...last8`; the renderer masks again as `sk-xxx****yyyy`. A client
 * that reads a list, edits one field, and writes the whole array back sends one
 * of those back, and a wholesale array replace persists it over the real value.
 * Observed 2026-09-27: creating a single key in the web admin left 6 of 7 keys
 * stored as the literal string `***`, with the enabled toggles still green, so
 * nothing looked wrong until a client received a 401.
 *
 * Because a real key can contain neither `*` nor `.`, any of these shapes is
 * unambiguously a mask.
 */
export function isMaskedApiKeyValue(value: unknown): boolean {
  if (typeof value !== 'string') return true
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  if (/^\*+$/.test(trimmed)) return true
  if (trimmed.includes('***') || trimmed.includes('****')) return true
  if (trimmed.includes('...')) return true
  return false
}

/**
 * Names of the entries in an incoming apiKeys array whose `key` is a mask.
 * Used to build an error message that names the affected keys.
 */
export function maskedApiKeyNames(apiKeys: unknown): string[] {
  if (!Array.isArray(apiKeys)) return []
  const names: string[] = []
  for (const entry of apiKeys) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { name?: unknown; key?: unknown }
    if (isMaskedApiKeyValue(record.key)) {
      names.push(typeof record.name === 'string' && record.name ? record.name : '<unnamed>')
    }
  }
  return names
}
