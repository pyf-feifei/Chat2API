import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { storeManager } from '../../store/store'
import type { Account } from '../../../shared/types'

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

const REFRESH_SCRIPT = process.env.QWEN_CAPTCHA_SOLVER_PATH || defaultRefreshScriptPath()
const REFRESH_TIMEOUT_MS = 180_000
const CHALLENGE_WINDOW_MS = 15 * 60_000
const CHALLENGE_THRESHOLD = 3
const REFRESH_COOLDOWN_MS = 30 * 60_000

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
export function noteQwenAiRiskChallenge(account: Account, evidence?: string): void {
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
  if (now - lastGlobalRefreshAt < REFRESH_COOLDOWN_MS) return
  if (globalRefreshInFlight) return
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
  void globalRefreshInFlight
}

/**
 * Run the browser-based refresher for one account and persist the harvested
 * cookies (x5sec family) plus token back into the store.
 */
export async function refreshQwenAiRiskSession(account: Account): Promise<Account | null> {
  const existing = inFlight.get(account.id)
  if (existing) return existing
  const operation = doRefresh(account)
  inFlight.set(account.id, operation)
  try {
    return await operation
  } finally {
    inFlight.delete(account.id)
  }
}

async function doRefresh(account: Account): Promise<Account | null> {
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
    '--headless',
    '--wait-seconds', '75',
  ]
  return new Promise(resolve => {
    const pythonCmd = platform() === 'win32' ? 'python' : 'python3'
    execFile(pythonCmd, args, {
      timeout: REFRESH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        CHROME_PATH: process.env.CHROME_PATH || '',
        QWEN_CAPTCHA_ARTIFACT_DIR: process.env.QWEN_CAPTCHA_ARTIFACT_DIR || '/tmp/qwen-captcha',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[QwenAI Risk Refresh] refresher failed:', error.message.slice(0, 200))
        if (stderr) console.error('[QwenAI Risk Refresh] stderr:', stderr.slice(0, 400))
        resolve(null)
        return
      }
      const lines = stdout.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]) as { cookies?: string; token?: string; solved_slider?: boolean }
          if (!parsed.cookies) continue
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
          const updated = storeManager.updateAccount(account.id, {
            credentials: {
              ...account.credentials,
              cookies: harvestedCookies,
              cookie: harvestedCookies,
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
          let propagated = 0
          try {
            const peers = storeManager.getAccountsByProviderId('qwen-ai', true)
            for (const peer of peers) {
              if (peer.id === account.id) continue
              storeManager.updateAccount(peer.id, {
                credentials: {
                  ...peer.credentials,
                  cookies: harvestedCookies,
                  cookie: harvestedCookies,
                },
              })
              propagated += 1
            }
          } catch (propError) {
            console.warn('[QwenAI Risk Refresh] x5sec fan-out failed:', propError instanceof Error ? propError.message : String(propError))
          }
          console.info('[QwenAI Risk Refresh] credentials updated', JSON.stringify({
            accountId: account.id,
            solvedSlider: parsed.solved_slider === true,
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
