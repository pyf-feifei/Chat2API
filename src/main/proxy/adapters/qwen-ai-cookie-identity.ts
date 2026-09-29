/**
 * Which cookies in a Qwen web jar belong to one account's identity.
 *
 * A browser jar mixes two kinds of state: exit/device risk cookies that other
 * accounts behind the same exit may reuse, and the signed-in identity of the
 * account the browser was logged in as. Identity is recognised from the data,
 * not from a list of cookie names: a signed token (JWT) is a per-user
 * credential, and a cookie whose value is that user's id carries the same
 * identity in another form.
 *
 * Observed 2026-09-29: the risk refresh fanned one account's whole jar out to
 * 339 peers. Every account then presented the same `token` cookie, which wins
 * over the account's own Bearer JWT, so the pool ran as a single user and kept
 * drawing bxpunish verdicts.
 */

export function parseCookieJar(header: string): Map<string, string> {
  const jar = new Map<string, string>()
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1))
  }
  return jar
}

export function serializeCookieJar(jar: ReadonlyMap<string, string>): string {
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ')
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

/**
 * The user a signed token was issued to. `undefined` means the value is not a
 * signed token; an empty string means it is one but names no user.
 */
export function signedTokenSubject(value: string): string | undefined {
  const parts = String(value || '').trim().split('.')
  if (parts.length !== 3 || parts.some(part => !part)) return undefined
  try {
    const header = decodeJsonSegment(parts[0]) as Record<string, unknown> | null
    if (!header || typeof header.alg !== 'string') return undefined
    const payload = decodeJsonSegment(parts[1]) as Record<string, unknown> | null
    const subject = payload?.id ?? payload?.sub
    return subject === undefined || subject === null ? '' : String(subject)
  } catch {
    return undefined
  }
}

/** Users named by any signed token among `values`. */
export function identitySubjects(values: Iterable<string>): Set<string> {
  const subjects = new Set<string>()
  for (const value of values) {
    const subject = signedTokenSubject(value)
    if (subject) subjects.add(subject)
  }
  return subjects
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** True when the value is, or contains as a whole token, one of `subjects`. */
function carriesSubject(value: string, subjects: ReadonlySet<string>): boolean {
  if (subjects.size === 0) return false
  const decoded = safeDecode(String(value || '').trim())
  if (subjects.has(decoded)) return true
  return decoded.split(/[^0-9A-Za-z_-]+/).some(part => subjects.has(part))
}

export function isIdentityCookie(value: string, subjects: ReadonlySet<string>): boolean {
  return signedTokenSubject(value) !== undefined || carriesSubject(value, subjects)
}

/**
 * Cookies a risk refresh may hand to other accounts: only what the refresh
 * itself produced (added or changed relative to the jar it started from), and
 * never anything identifying the account the browser was signed in as.
 */
export function riskCookiesForPeers(
  previousJar: string,
  harvestedJar: string,
  sourceTokens: readonly string[] = [],
): Map<string, string> {
  const previous = parseCookieJar(previousJar)
  const harvested = parseCookieJar(harvestedJar)
  const subjects = identitySubjects([...sourceTokens, ...previous.values(), ...harvested.values()])
  const shared = new Map<string, string>()
  for (const [name, value] of harvested) {
    if (previous.get(name) === value) continue
    if (isIdentityCookie(value, subjects)) continue
    shared.set(name, value)
  }
  return shared
}

/** Overlay shared risk cookies onto a peer's jar, keeping everything else. */
export function mergeRiskCookiesIntoJar(peerJar: string, riskCookies: ReadonlyMap<string, string>): string {
  if (riskCookies.size === 0) return String(peerJar || '')
  const jar = parseCookieJar(peerJar)
  for (const [name, value] of riskCookies) jar.set(name, value)
  return serializeCookieJar(jar)
}

function claimShape(value: string): string {
  try {
    const payload = decodeJsonSegment(String(value).trim().split('.')[1]) as Record<string, unknown>
    return Object.keys(payload || {}).sort().join(',')
  } catch {
    return ''
  }
}

/**
 * Rebind cookies that identify a different user than `ownToken` to this
 * account. A foreign token of the same kind as the account's own token (same
 * claim set) becomes the own token, and a cookie holding the foreign user id
 * becomes the own user id; foreign identity that cannot be rebuilt from the
 * account's own credential is dropped. The jar is returned unchanged when the
 * owner cannot be established or nothing foreign is found, so an account is
 * never rewritten on a guess.
 */
export function rebindForeignIdentity(jarHeader: string, ownToken: string): string {
  const header = String(jarHeader || '')
  const token = String(ownToken || '').trim()
  const own = signedTokenSubject(token)
  if (!own) return header
  const jar = parseCookieJar(header)
  const foreign = new Set(Array.from(identitySubjects(jar.values())).filter(subject => subject !== own))
  if (foreign.size === 0) return header
  const ownShape = claimShape(token)
  let changed = false
  for (const [name, value] of Array.from(jar)) {
    const subject = signedTokenSubject(value)
    if (subject !== undefined) {
      if (subject === own) continue
      if (subject && claimShape(value) === ownShape) jar.set(name, token)
      else jar.delete(name)
      changed = true
      continue
    }
    if (!carriesSubject(value, foreign)) continue
    if (foreign.has(safeDecode(value.trim()))) jar.set(name, own)
    else jar.delete(name)
    changed = true
  }
  return changed ? serializeCookieJar(jar) : header
}
