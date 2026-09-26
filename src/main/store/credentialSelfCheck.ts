import type { Account } from './types.ts'
import { ENCRYPTION_PREFIX } from '../runtime/types.ts'

/**
 * Credential readability self-check.
 *
 * Why this exists
 * ---------------
 * On 2026-09-26 a local Docker instance lost `CHAT2API_STORAGE_ENCRYPTION_KEY`
 * (the container had been created with `docker run`, so `.env` was never
 * injected, and the key was added to `.env` afterwards without a recreate).
 * The failure was completely silent:
 *
 *   isEncryptionAvailable() -> false
 *   decryptData('c2a:v1:...') -> returns the CIPHERTEXT unchanged
 *   => every account's cookies looked like the literal string "c2a:v1:E++U+Z4..."
 *   => hasQwenAiWebSessionCookie() false for all 340 accounts
 *   => session repair judged ready=0 pending=339 and issued 339 signins / 25 s
 *   => those signins carried garbage credentials, the upstream answered 401
 *      "email not found", a rejection storm opened the refresh risk gate
 *      (300 s -> 600 s -> 1200 s -> 2400 s, capped at 1 h)
 *   => every request, including plain chat, failed 403 qwen_ai_token_refresh_gated
 *
 * Nothing threw. The instance simply degraded into being blocked by risk
 * control, which reads like an account/pool problem and is very hard to
 * attribute back to a missing environment variable.
 *
 * The two checks below turn that silent degradation into a loud, immediate
 * signal.
 */

export interface CredentialSelfCheckReport {
  /** Encryption runtime is usable. */
  encryptionAvailable: boolean
  /** Accounts inspected. */
  inspected: number
  /** Accounts whose stored cookie jar still looks like ciphertext. */
  encryptedLooking: number
  /** Accounts whose cookie jar carries a usable session token. */
  sessionReady: number
  /** Fatal: encrypted data but no key. */
  fatal: boolean
  /** Human-readable problems, empty when healthy. */
  problems: string[]
}

/**
 * Raised when stored credentials cannot be decrypted at all.
 *
 * This is deliberately a distinct type: `StoreManager.initialize()` has a
 * corrupt-store recovery path that backs the file up and re-initializes. That
 * path would happily "recover" from an unreadable-but-intact store and start the
 * process with garbage credentials, which is exactly the silent degradation
 * this check exists to prevent. The store re-throws this error instead.
 */
export class CredentialUnreadableError extends Error {
  readonly fatal = true
  constructor(message: string) {
    super(message)
    this.name = 'CredentialUnreadableError'
  }
}

/** Cookie names that mark a usable Qwen web session. */
function hasSessionCookie(cookieHeader: string): boolean {
  return /(?:^|;\s*)token=/.test(String(cookieHeader || ''))
}

function looksEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX)
}

function cookieHeaderOf(credentials: Record<string, string> | undefined): string {
  if (!credentials) return ''
  return String(credentials.cookies || credentials.cookie || '')
}

/**
 * Inspect a set of accounts and report whether their credentials can actually
 * be used. Pure: no I/O, no logging, so it is straightforward to unit test.
 *
 * @param accounts Raw accounts as they sit in the store, i.e. with encrypted
 *   credential fields still encrypted.
 * @param encryptionAvailable Result of `runtime.isEncryptionAvailable()`.
 * @param decrypt Function that decrypts one stored value. Defaults to identity,
 *   which is exactly the production behaviour when no key is configured.
 */
export function inspectCredentialHealth(
  accounts: readonly Account[],
  encryptionAvailable: boolean,
  decrypt: (value: string) => string = (value) => value,
): CredentialSelfCheckReport {
  const problems: string[] = []
  let encryptedLooking = 0
  let sessionReady = 0
  let inspected = 0

  for (const account of accounts) {
    const credentials = account?.credentials as Record<string, string> | undefined
    if (!credentials) continue
    const rawCookie = cookieHeaderOf(credentials)
    if (!rawCookie && !credentials.token) continue

    inspected += 1

    // Decrypt first, then judge. The stored value is *expected* to carry the
    // ciphertext prefix whenever a key is configured, so the prefix only means
    // "unreadable" once decryption has failed to remove it — which is exactly
    // what `decrypt` returns unchanged when no key is available.
    const cookie = decrypt(rawCookie)
    if (looksEncrypted(cookie)) {
      encryptedLooking += 1
      continue
    }

    if (hasSessionCookie(cookie)) sessionReady += 1
  }

  // Check 1 (fatal): the payload is still ciphertext after decryption, which
  // only happens when no key reached the process.
  const anyEncrypted = encryptedLooking > 0
  if (!encryptionAvailable && anyEncrypted) {
    problems.push(
      `Credential data is encrypted (${ENCRYPTION_PREFIX}…) but encryption is not available. `
      + 'Credentials cannot be decrypted, so every account is treated as having no session. '
      + 'Set CHAT2API_STORAGE_ENCRYPTION_KEY to the value used when the data was written, '
      + 'and recreate the instance so the variable actually reaches the process '
      + '(a container started with `docker run` never reads .env).',
    )
  }

  // Check 2 (loud warning): readable, yet nothing can authenticate.
  if (encryptionAvailable && inspected > 0 && sessionReady === 0) {
    problems.push(
      `None of the ${inspected} inspected accounts carries a usable session cookie `
      + '(`token=`). The session-repair queue will treat the whole pool as not ready and '
      + 'issue a signin per account, which the upstream answers with 401 "email not found" '
      + 'and risk control blocks the egress. Re-import the accounts or verify the stored '
      + 'cookies.',
    )
  }

  return {
    encryptionAvailable,
    inspected,
    encryptedLooking,
    sessionReady,
    fatal: !encryptionAvailable && anyEncrypted,
    problems,
  }
}

function log(message: string): void {
  console.error(`[CredentialSelfCheck] ${message}`)
}

/**
 * Run the self-check and log a report. Throws when the failure mode is fatal so
 * the process stops instead of silently degrading.
 *
 * Set `CHAT2API_CREDENTIAL_SELF_CHECK=off` to downgrade the fatal case to a
 * warning (for example while intentionally running with a plaintext store).
 */
export function assertCredentialHealth(
  accounts: readonly Account[],
  isEncryptionAvailable: boolean,
  decrypt: (value: string) => string,
): CredentialSelfCheckReport {
  const report = inspectCredentialHealth(accounts, isEncryptionAvailable, decrypt)

  const disabled = ['off', '0', 'false', 'no'].includes(
    String(process.env.CHAT2API_CREDENTIAL_SELF_CHECK ?? '').trim().toLowerCase(),
  )

  if (report.fatal) {
    const message = [
      report.problems[0],
      '',
      'Refusing to start with unreadable credentials. This exact state degrades into',
      'upstream risk control and looks like an account outage.',
      'Set CHAT2API_CREDENTIAL_SELF_CHECK=off to bypass (only valid for a plaintext store).',
    ].join('\n')
    if (disabled) {
      log(`BYPASSED: ${report.problems[0]}`)
      return report
    }
    log(message)
    throw new CredentialUnreadableError(
      'Credential data is encrypted but CHAT2API_STORAGE_ENCRYPTION_KEY is not usable',
    )
  }

  if (report.problems.length > 0) {
    log(`WARNING: ${report.problems[0]}`)
  } else if (process.env.CHAT2API_LOG_LEVEL === 'debug') {
    log(
      `ok: ${report.inspected} accounts inspected, ${report.sessionReady} session-ready, `
      + 'encryption available',
    )
  }

  return report
}
