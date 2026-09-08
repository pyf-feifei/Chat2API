import { execFile } from 'child_process'
import { storeManager } from '../../store/store'

const SOLVER_SCRIPT = process.env.ZAI_CAPTCHA_SOLVER_PATH || '/app/scripts/zai-captcha/solve.py'
const MANAGEMENT_URL = process.env.ZAI_MANAGEMENT_URL || 'http://127.0.0.1:8080'
const MANAGEMENT_SECRET = process.env.ZAI_MANAGEMENT_SECRET || process.env.CHAT2API_MANAGEMENT_SECRET || ''
const SOLVER_TIMEOUT_MS = 120000

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

  const solvePromise = doSolve(accountId, token)
  solvingAccounts.set(accountId, solvePromise)

  try {
    return await solvePromise
  } finally {
    solvingAccounts.delete(accountId)
  }
}

async function doSolve(accountId: string, token: string): Promise<string | null> {
  console.log(`[Z.ai Captcha] Starting captcha solve for account ${accountId}`)

  return new Promise((resolve) => {
    const args = [
      SOLVER_SCRIPT,
      '--token', token,
      '--account-id', accountId,
      '--management-url', MANAGEMENT_URL,
      '--management-secret', MANAGEMENT_SECRET,
      '--headless',
      '--wait-seconds', '60',
    ]

    const child = execFile('python3', args, {
      timeout: SOLVER_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Z.ai Captcha] Solver failed:`, error.message)
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
