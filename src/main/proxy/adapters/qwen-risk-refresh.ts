import { execFile } from 'child_process'
import { platform } from 'os'
import { storeManager } from '../../store/store'
import type { Account } from '../../../shared/types'

const REFRESH_SCRIPT = process.env.QWEN_CAPTCHA_SOLVER_PATH || '/app/scripts/qwen-captcha/refresh.py'
const REFRESH_TIMEOUT_MS = 180_000
const CHALLENGE_WINDOW_MS = 15 * 60_000
const CHALLENGE_THRESHOLD = 3
const REFRESH_COOLDOWN_MS = 30 * 60_000

const challengeByAccount = new Map<string, number[]>()
const lastRefreshAt = new Map<string, number>()
const inFlight = new Map<string, Promise<Account | null>>()

/**
 * Record that an account's request hit the RGV587 validation envelope
 * (FAIL_SYS_USER_VALIDATE + 被挤爆). After CHALLENGE_THRESHOLD hits inside
 * the window, kick one background risk-session refresh — a real browser
 * passes the aliyun slider and re-issues the risk cookies (x5sec family),
 * which is the community-verified durable fix for content-flagged sessions.
 */
export function noteQwenAiRiskChallenge(account: Account, evidence?: string): void {
  const envelope = /FAIL_SYS_USER_VALIDATE|RGV587/i.test(String(evidence ?? ''))
  if (!envelope) return
  const id = account.id
  const now = Date.now()
  const hits = (challengeByAccount.get(id) ?? []).filter(ts => now - ts < CHALLENGE_WINDOW_MS)
  hits.push(now)
  challengeByAccount.set(id, hits)
  if (hits.length < CHALLENGE_THRESHOLD) return
  const last = lastRefreshAt.get(id) ?? 0
  if (now - last < REFRESH_COOLDOWN_MS) return
  if (inFlight.has(id)) return
  lastRefreshAt.set(id, now)
  challengeByAccount.set(id, [])
  console.warn('[QwenAI Risk Refresh] RGV587 challenge threshold hit, refreshing risk session', JSON.stringify({
    accountId: id,
    challenges: CHALLENGE_THRESHOLD,
    windowMs: CHALLENGE_WINDOW_MS,
  }))
  void refreshQwenAiRiskSession(account).then(result => {
    if (result) {
      console.info('[QwenAI Risk Refresh] risk session updated', JSON.stringify({ accountId: id }))
    }
  }).catch(error => {
    console.error('[QwenAI Risk Refresh] failed:', error instanceof Error ? error.message : String(error))
  })
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
          const updated = storeManager.updateAccount(account.id, {
            credentials: {
              ...account.credentials,
              cookies: parsed.cookies,
              cookie: parsed.cookies,
              ...(parsed.token ? { token: parsed.token } : {}),
            },
          })
          if (!updated) {
            console.error('[QwenAI Risk Refresh] account not found in store:', account.id)
            resolve(null)
            return
          }
          console.info('[QwenAI Risk Refresh] credentials updated', JSON.stringify({
            accountId: account.id,
            solvedSlider: parsed.solved_slider === true,
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
