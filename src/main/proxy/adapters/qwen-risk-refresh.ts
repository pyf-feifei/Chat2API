import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { platform } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { storeManager } from '../../store/store'
import type { Account } from '../../../shared/types'
import { resetQwenAiRefreshFaultTracking } from './qwen-ai-token-refresh'
import {
  mergeRiskCookiesIntoJar,
  riskCookiesForPeers,
  rebindForeignIdentity,
} from './qwen-ai-cookie-identity'

// Resolve the bundled solver so the default works in every layout:
//   dev/tsx   : this file sits at <repo>/src/main/proxy/adapters -> repo/scripts
//   built srv : bundled into <repo>/out-server/...              -> repo/scripts
//   container : /app/out-server/...                            -> /app/scripts
// Try candidates in order; the first that exists wins. The env var remains an
// explicit override for non-standard layouts.
function defaultRefreshScriptPath(): string {
  const rel = join('scripts', 'qwen-captcha', 'refresh.py')
  const candidates: string[] = []
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // Walk up: dev needs 4 levels (adapters->proxy->main->src->repo), the built
    // bundle needs 1-2 (out-server/<chunk> -> repo). Probe every ancestor.
    let dir = here
    for (let depth = 0; depth < 6; depth += 1) {
      candidates.push(join(dir, rel))
      dir = dirname(dir)
    }
  } catch {
    // import.meta unavailable — fall through to absolute candidates
  }
  candidates.push(join('/app', rel))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return '/app/scripts/qwen-captcha/refresh.py'
}

export interface QwenAiRiskRecoveryEvidence {
  cookies?: string
  token?: string
  solved_slider?: boolean
  probe_verified?: boolean
  risk_page?: boolean
  probe_model?: string
  probe_mode?: string
  probe_model_verified?: boolean
}

export function hasVerifiedQwenAiRiskRecovery(result: QwenAiRiskRecoveryEvidence): boolean {
  // Cookie harvests and mouse releases alone are not recovery evidence. Require
  // the fresh browser probe to answer and the active challenge to be gone.
  const requestedModel = String(process.env.QWEN_RECOVERY_PROBE_MODEL || '').trim().toLowerCase()
  const requestedMode = String(process.env.QWEN_RECOVERY_PROBE_MODE || '').trim().toLowerCase()
  const modelVerified = !requestedModel || (
    result.probe_model_verified === true
    && result.probe_model?.toLowerCase() === requestedModel
    && (!requestedMode || result.probe_mode?.toLowerCase() === requestedMode)
  )
  return typeof result.cookies === 'string' && result.cookies.trim().length > 0
    && result.probe_verified === true && result.risk_page === false && modelVerified
}

export function parseQwenAiRiskFailureDiagnostics(stdout: string): Record<string, boolean | number | string> | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const diagnostic = JSON.parse(line)?.diagnostics
      if (!diagnostic || typeof diagnostic !== 'object') continue
      const safe: Record<string, boolean | number | string> = {}
      if (['probe_unverified', 'browser_timeout', 'browser_failure'].includes(diagnostic.error_code)) {
        safe.errorCode = diagnostic.error_code
      }
      const stages = ['browser_start', 'navigation', 'verification', 'login_navigation', 'login_route', 'login_antibot_ready', 'login_email', 'login_password_toggle', 'login_submit', 'verification_after_login']
      if (stages.includes(diagnostic.stage)) safe.stage = diagnostic.stage
      for (const key of ['probe_sent', 'probe_verified', 'risk_page', 'auth_rejected', 'screenshot_written']) {
        if (typeof diagnostic[key] === 'boolean') safe[key] = diagnostic[key]
      }
      for (const key of ['challenge_attempts', 'overlay_dismissals', 'visible_dialogs']) {
        if (Number.isSafeInteger(diagnostic[key]) && diagnostic[key] >= 0 && diagnostic[key] <= 100) safe[key] = diagnostic[key]
      }
      return safe
    } catch { /* Ignore progress lines; raw child output may contain secrets. */ }
  }
  return undefined
}

const REFRESH_SCRIPT = process.env.QWEN_CAPTCHA_SOLVER_PATH || defaultRefreshScriptPath()
const REFRESH_TIMEOUT_MS = 180_000
const CHALLENGE_WINDOW_MS = 15 * 60_000
const CHALLENGE_THRESHOLD = 1
// A verified clearance can expire or be challenged again long before 30m.
// Single-flight plus a short cooldown bounds browser launches without leaving
// a newly challenged session stuck behind yesterday's successful recovery.
const REFRESH_COOLDOWN_MS = 60_000

// RGV587 (FAIL_SYS_USER_VALIDATE) is an exit-IP / browser-fingerprint verdict,
// not an account verdict: rotating accounts behind the same flagged exit keeps
// hitting the same challenge. Counting challenges per account can therefore
// never reach the threshold — under "rotate on first busy" failover no single
// account accumulates CHALLENGE_THRESHOLD hits in the window (observed live
// 2026-09-17: 12 accounts × 2 hits each → zero refreshes). Count challenges
// globally against the shared exit instead.
const globalChallengeTimestamps: number[] = []
// One refresh at a time for the whole pool — a single slider pass re-issues
// the exit-level x5sec family that every account behind the exit can reuse.
let globalRefreshInFlight: Promise<Account | null> | undefined
let lastGlobalRefreshAt = 0
let cooldownRefreshInFlight: Promise<Account | null> | undefined
// Per-account in-flight guard for the manual refresh entry point
// (refreshQwenAiRiskSession), kept separate from the pool-wide gate so a manual
// trigger on account A and an auto trigger on account B cannot both spawn a
// browser at once.
const inFlight = new Map<string, Promise<Account | null>>()

/**
 * Record that a request hit the RGV587 validation envelope
 * (FAIL_SYS_USER_VALIDATE + 被挤爆). After CHALLENGE_THRESHOLD hits inside
 * the window across ANY account on the shared exit, kick one background
 * risk-session refresh — a real browser passes the aliyun slider and re-issues
 * the risk cookies (x5sec family), which is the community-verified durable fix
 * for content-flagged sessions.
 */
export function noteQwenAiRiskChallenge(account: Account, evidence?: string): Promise<Account | null> | undefined {
  // bxpunish is the same aliyun (baxia) verdict family as RGV587 but arrives as
  // a response header on a 503 busy body, not as error text — the caller folds
  // it into the evidence string so the shared-exit counter can trip the same
  // browser x5sec refresh. Without it, bxpunish hits never refreshed cookies.
  const envelope = /FAIL_SYS_USER_VALIDATE|RGV587|bxpunish/i.test(String(evidence ?? ''))
  if (!envelope) return
  const now = Date.now()
  // Global exit-level window: drop hits older than the window, then count.
  while (globalChallengeTimestamps.length > 0 && now - globalChallengeTimestamps[0] >= CHALLENGE_WINDOW_MS) {
    globalChallengeTimestamps.shift()
  }
  globalChallengeTimestamps.push(now)
  if (globalChallengeTimestamps.length < CHALLENGE_THRESHOLD) return
  if (globalRefreshInFlight) return globalRefreshInFlight
  if (now - lastGlobalRefreshAt < REFRESH_COOLDOWN_MS) {
    // A cooldown limits browser launches, not recovery eligibility. Returning
    // undefined here made the caller mark recovery as observed forever and
    // replay a challenged request without ever opening a browser.
    if (!cooldownRefreshInFlight) {
      const delayMs = REFRESH_COOLDOWN_MS - (now - lastGlobalRefreshAt)
      cooldownRefreshInFlight = new Promise<void>(resolve => setTimeout(resolve, delayMs))
        .then(() => {
          cooldownRefreshInFlight = undefined
          const latest = storeManager.getAccountById?.(account.id, true) ?? account
          return noteQwenAiRiskChallenge(latest, evidence) ?? null
        })
    }
    return cooldownRefreshInFlight
  }
  lastGlobalRefreshAt = now
  globalChallengeTimestamps.length = 0
  console.warn('[QwenAI Risk Refresh] RGV587 challenge threshold hit, refreshing risk session', JSON.stringify({
    triggerAccountId: account.id,
    challenges: CHALLENGE_THRESHOLD,
    windowMs: CHALLENGE_WINDOW_MS,
  }))
  globalRefreshInFlight = refreshQwenAiRiskSession(account)
    .then(result => {
      if (result) {
        console.info('[QwenAI Risk Refresh] risk session updated', JSON.stringify({ accountId: result.id }))
      }
      return result
    })
    .catch(error => {
      console.error('[QwenAI Risk Refresh] failed:', error instanceof Error ? error.message : String(error))
      return null
    })
    .finally(() => {
      globalRefreshInFlight = undefined
    })
  return globalRefreshInFlight
}

/**
 * A punish URL the refresher should enter deliberately.
 *
 * When the egress IP carries an aliyun risk flag, API-shaped requests are
 * punished while a real browser passes invisibly — the organic login flow then
 * never sees a slider and the harvest returns `solved_slider:false` with no
 * x5sec (observed 2026-10-14: all three exits flagged, harvests useless).
 * Feeding a punish URL captured from an actually-punished request drops the
 * solver straight into the baxia challenge, where a pass re-issues the x5sec
 * the API path needs. Structural validation only: the URL must point at the
 * Qwen host; anything else is rejected before it reaches the browser.
 */
export function normalizeQwenAiPunishUrl(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim()
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chat.qwen.ai') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Run the browser-based refresher for one account and persist the harvested
 * cookies (x5sec family) plus token back into the store.
 */
export async function refreshQwenAiRiskSession(
  account: Account,
  options: { punishUrl?: string } = {},
): Promise<Account | null> {
  const existing = inFlight.get(account.id)
  if (existing) return existing
  const operation = doRefresh(account, options.punishUrl)
  inFlight.set(account.id, operation)
  try {
    return await operation
  } finally {
    inFlight.delete(account.id)
  }
}

async function doRefresh(account: Account, punishUrl?: string): Promise<Account | null> {
  const token = String(account.credentials.token || '').trim()
  if (!token) {
    console.error('[QwenAI Risk Refresh] account has no token:', account.id)
    return null
  }
  const cookies = String(account.credentials.cookies || account.credentials.cookie || '').trim()
  const args = [
    REFRESH_SCRIPT,
    '--token', token,
    '--cookies', cookies,
    '--account-id', account.id,
    '--wait-seconds', '75',
  ]
  // Desktop can use the same headed Chrome path as the validated skill.
  // Servers without a display stay headless unless explicitly configured.
  const headless = process.env.QWEN_CAPTCHA_HEADLESS?.trim().toLowerCase()
  if (headless ? !['0', 'false', 'off'].includes(headless) : platform() === 'linux' && !process.env.DISPLAY) {
    args.push('--headless')
  }
  if (punishUrl) {
    const normalized = normalizeQwenAiPunishUrl(punishUrl)
    if (!normalized) {
      console.error('[QwenAI Risk Refresh] invalid punish URL')
      return null
    }
    args.push('--punish-url', normalized)
  }
  const recoveryId = randomUUID()
  const artifactDir = join(process.env.QWEN_CAPTCHA_ARTIFACT_DIR || '/tmp/qwen-captcha', recoveryId)
  return new Promise(resolve => {
    const pythonCmd = platform() === 'win32' ? 'python' : 'python3'
    execFile(pythonCmd, args, {
      timeout: REFRESH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        CHROME_PATH: process.env.CHROME_PATH || '',
        // Saved login never appears in argv or child diagnostics.
        QWEN_LOGIN_EMAIL: account.credentials.email || '',
        QWEN_LOGIN_PASSWORD: account.credentials.password || '',
        QWEN_CAPTCHA_ARTIFACT_DIR: artifactDir,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        // execFile errors include the full command line (token and cookies).
        // Report metadata only; never echo child arguments or raw tracebacks.
        console.error('[QwenAI Risk Refresh] refresher failed', JSON.stringify({
          accountId: account.id,
          code: error.code,
          signal: error.signal,
          killed: error.killed,
          hasStderr: Boolean(stderr),
          recoveryId,
          artifactDir,
          diagnostics: parseQwenAiRiskFailureDiagnostics(stdout),
        }))
        resolve(null)
        return
      }
      const lines = stdout.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]) as QwenAiRiskRecoveryEvidence
          if (!parsed || !parsed.cookies) continue
          if (!hasVerifiedQwenAiRiskRecovery(parsed)) {
            console.warn('[QwenAI Risk Refresh] unverified harvest ignored', JSON.stringify({
              accountId: account.id,
              solvedSlider: parsed.solved_slider === true,
              probeVerified: parsed.probe_verified === true,
              riskPage: parsed.risk_page,
            }))
            resolve(null)
            return
          }
          // Strip Chat2API's own encrypted credential artifacts (`c2a:` values)
          // from the harvested cookie jar. The refresher runs in a browser that
          // may have stored encrypted creds from a prior injection; replaying
          // that ciphertext as a live Cookie value breaks every account it is
          // fanned out to (observed 2026-09-19: propagatedToAccounts=339 →
          // qwen_ai_token_refresh_failed on the whole pool). A part is dropped
          // when it has no `=` (a bare ciphertext blob) or its value is a `c2a:`
          // blob — neither is a real `name=value` browser cookie.
          const harvestedCookies = String(parsed.cookies)
            .split(';')
            .map(part => part.trim())
            .filter(part => {
              if (!part) return false
              const eq = part.indexOf('=')
              if (eq < 0) return false                       // bare blob (e.g. a lone ciphertext)
              if (/^c2a:/i.test(part)) return false          // whole-blob ciphertext
              if (/=c2a:/i.test(part)) return false          // name=c2a:ciphertext
              return true
            })
            .join('; ')
          // The harvested token is only usable when it's a real JWT — a `c2a:`
          // blob is Chat2API's own ciphertext from a prior injection, not a
          // credential the upstream can verify. Skip writing it back so the
          // account keeps its previous (working) token.
          const harvestedToken = parsed.token && !/^c2a:/i.test(String(parsed.token).trim())
            ? parsed.token
            : undefined
          // The browser was seeded with the stored jar, so identity cookies of
          // another user already in it come straight back; keep only this
          // account's own session in its jar.
          const ownCookies = rebindForeignIdentity(harvestedCookies, String(harvestedToken || token))
          const updated = storeManager.updateAccount(account.id, {
            credentials: {
              ...account.credentials,
              cookies: ownCookies,
              cookie: ownCookies,
              ...(harvestedToken ? { token: harvestedToken } : {}),
            },
          })
          if (!updated) {
            console.error('[QwenAI Risk Refresh] account not found in store:', account.id)
            resolve(null)
            return
          }
          // The harvested x5sec family is bound to the shared exit/browser
          // fingerprint, not to this one Qwen account. Fan it out to every
          // other qwen-ai account so the whole pool behind the same flagged
          // exit benefits from a single slider pass — otherwise each account
          // would keep failing until it individually re-triggered a refresh.
          // Only the cookies this refresh produced travel, and never the
          // signed-in identity: copying the whole jar made all 340 accounts
          // present one account's session (2026-09-29).
          const riskCookies = riskCookiesForPeers(
            cookies,
            harvestedCookies,
            [token, String(harvestedToken || '')],
          )
          let propagated = 0
          try {
            const peers = riskCookies.size > 0
              ? storeManager.getAccountsByProviderId('qwen-ai', true)
              : []
            for (const peer of peers) {
              if (peer.id === account.id) continue
              const peerJar = String(peer.credentials.cookies || peer.credentials.cookie || '')
              const merged = mergeRiskCookiesIntoJar(peerJar, riskCookies)
              if (merged === peerJar) continue
              storeManager.updateAccount(peer.id, {
                credentials: {
                  ...peer.credentials,
                  cookies: merged,
                  cookie: merged,
                },
              })
              propagated += 1
            }
          } catch (propError) {
            console.warn('[QwenAI Risk Refresh] x5sec fan-out failed:', propError instanceof Error ? propError.message : String(propError))
          }
          // A fresh authenticated browser probe proves this account's auth
          // path works again; do not keep the earlier refresh-WAF gate alive.
          resetQwenAiRefreshFaultTracking()
          console.info('[QwenAI Risk Refresh] credentials updated', JSON.stringify({
            accountId: account.id,
            solvedSlider: parsed.solved_slider === true,
            probeVerified: parsed.probe_verified === true,
            probeScope: process.env.QWEN_RECOVERY_PROBE_MODEL ? 'configured-model' : 'browser-default-model',
            probeModelVerified: parsed.probe_model_verified === true,
            sharedCookies: Array.from(riskCookies.keys()),
            propagatedToAccounts: propagated,
          }))
          resolve(updated)
          return
        } catch {
          // Not the JSON result line — keep scanning backwards.
        }
      }
      console.error('[QwenAI Risk Refresh] no JSON result in refresher output')
      resolve(null)
    })
  })
}
