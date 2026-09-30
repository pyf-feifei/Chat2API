import { execFile } from 'child_process'
import { storeManager } from '../../store/store'
import {
  resolvePythonBin,
  resolveEnvInt,
  solverScriptPath,
} from './zai-solver-runtime.ts'
import { zaiCaptchaBreaker } from './zai-captcha-breaker.ts'

const MANAGEMENT_URL = process.env.ZAI_MANAGEMENT_URL || 'http://127.0.0.1:8080'
const MANAGEMENT_SECRET = process.env.ZAI_MANAGEMENT_SECRET || process.env.CHAT2API_MANAGEMENT_SECRET || ''

function solverTimeoutMs(): number {
  return resolveEnvInt(process.env.ZAI_CAPTCHA_TIMEOUT_MS, 120000, { min: 1000 })
}

function solverWaitSeconds(): number {
  return resolveEnvInt(process.env.ZAI_CAPTCHA_WAIT_SECONDS, 60, { min: 5, max: 3600 })
}

const solvingAccounts = new Map<string, Promise<string | null>>()

export async function solveZaiCaptcha(
  accountId: string,
  token: string,
): Promise<string | null> {
  const existing = solvingAccounts.get(accountId)
  if (existing) {
    console.log(`[Z.ai Captcha] Already solving for account ${accountId}, waiting...`)
    return existing
  }

  // Failed solves raise the shared egress's risk score until the WAF blocks
  // it outright; stop launching browsers while the breaker is open.
  const decision = zaiCaptchaBreaker.tryAcquire()
  if (!decision.allowed) {
    console.warn('[Z.ai Captcha] Circuit breaker open; skipping solve', JSON.stringify({
      accountId,
      consecutiveFailures: decision.consecutiveFailures,
      retryInS: Math.ceil(decision.retryInMs / 1000),
    }))
    return null
  }
  if (decision.probe) console.log(`[Z.ai Captcha] Circuit breaker half-open; probe solve for account ${accountId}`)

  const solvePromise = doSolve(accountId, token)
  solvingAccounts.set(accountId, solvePromise)

  try {
    const param = await solvePromise
    if (param) {
      zaiCaptchaBreaker.recordSuccess()
    } else if (zaiCaptchaBreaker.recordFailure()) {
      const snap = zaiCaptchaBreaker.snapshot()
      console.warn('[Z.ai Captcha] Circuit breaker opened after consecutive solve failures', JSON.stringify({
        consecutiveFailures: snap.consecutiveFailures,
        cooldownS: Math.round(snap.cooldownMs / 1000),
      }))
    }
    return param
  } catch (error) {
    zaiCaptchaBreaker.releaseProbe()
    throw error
  } finally {
    solvingAccounts.delete(accountId)
  }
}

/** True while the solve breaker refuses new solves (callers skip retries). */
export function isZaiCaptchaBreakerOpen(): boolean {
  const snap = zaiCaptchaBreaker.snapshot()
  return snap.openUntil > Date.now()
}

async function doSolve(accountId: string, token: string): Promise<string | null> {
  console.log(`[Z.ai Captcha] Starting captcha solve for account ${accountId}`)

  return new Promise((resolve) => {
    const args = [
      solverScriptPath(),
      '--token', token,
      '--account-id', accountId,
      '--management-url', MANAGEMENT_URL,
      '--management-secret', MANAGEMENT_SECRET,
      '--headless',
      '--wait-seconds', String(solverWaitSeconds()),
    ]

    // Same interpreter probe as the credential refresh: the first `python` on
    // PATH is regularly an install without patchright, and that failure is
    // indistinguishable from a dead account.
    const pythonCmd = resolvePythonBin()
    const child = execFile(pythonCmd, args, {
      timeout: solverTimeoutMs(),
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        // error.message embeds the argv, and the argv carries the account token.
        const safeMessage = String(error.message || 'Command failed')
          .replace(/(--token\s+)\S+/gi, '$1[REDACTED]')
          .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
        console.error(`[Z.ai Captcha] Solver failed:`, safeMessage)
        if (stderr) console.error(`[Z.ai Captcha] stderr:`, stderr.substring(0, 500))
        resolve(null)
        return
      }

      const lines = stdout.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i])
          if (parsed.captcha_verify_param) {
            console.log(`[Z.ai Captcha] Solved! Param length: ${parsed.captcha_verify_param.length}`)
            resolve(parsed.captcha_verify_param)
            return
          }
        } catch {
          // Not JSON, continue
        }
      }

      console.error(`[Z.ai Captcha] No valid JSON output found`)
      console.log(`[Z.ai Captcha] stdout:`, stdout.substring(0, 500))
      resolve(null)
    })

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (text.includes('SUCCESS') || text.includes('Error') || text.includes('failed') || text.includes('Intercepted')) {
        console.log(`[Z.ai Captcha] Solver:`, text.trim().substring(0, 200))
      }
    })
  })
}

export async function solveCaptchaAndUpdateAccount(
  accountId: string,
  token: string,
): Promise<boolean> {
  const captchaParam = await solveZaiCaptcha(accountId, token)
  if (!captchaParam) return false

  const account = storeManager.getAccountById(accountId, true)
  if (account) {
    storeManager.updateAccount(accountId, {
      credentials: {
        ...account.credentials,
        captcha_verify_param: captchaParam,
      },
    })
    console.log(`[Z.ai Captcha] Updated account ${accountId} with new captcha_verify_param`)
    return true
  }

  return false
}

export function isCaptchaRequiredError(error: any): boolean {
  if (!error) return false
  const code = error.code || error.error_code || ''
  const detail = error.detail || ''
  return code === 'FRONTEND_CAPTCHA_REQUIRED' ||
    detail.includes('FRONTEND_CAPTCHA_REQUIRED') ||
    detail.includes('刷新页面') ||
    JSON.stringify(error).includes('FRONTEND_CAPTCHA_REQUIRED')
}
