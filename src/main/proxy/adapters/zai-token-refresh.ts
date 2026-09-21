import { execFile, spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { platform } from 'os'
// Explicit .ts extensions keep this module loadable by `node --test`, which
// resolves imports natively instead of through the bundler.
import type { Account } from '../../store/types.ts'
import { storeManager } from '../../store/store.ts'

/**
 * Z.ai has no refresh_token endpoint: login JWTs are issued without `exp` and
 * stay valid until Z.ai actively revokes them (risk-control kick, ban, or a
 * server-side session purge). "Refreshing" therefore means re-authenticating
 * and swapping in a freshly minted JWT.
 *
 * Z.ai only exposes email+password on the OAuth authorize page (the plain
 * /auth route is phone + SMS), and that form is captcha-gated. `scripts/
 * zai-captcha/solve.py --mode signin` drives the real login form in Playwright,
 * solves the captcha, and returns the JWT the SPA stores. Everything happens in
 * one browser session because the captcha is bound to that session's
 * fingerprint, so a bare axios call from Node is always rejected.
 */

// Read configuration lazily so it can be changed at runtime and overridden in
// tests, instead of being frozen at module load.
function solverScriptPath(): string {
  return process.env.ZAI_CAPTCHA_SOLVER_PATH || '/app/scripts/zai-captcha/solve.py'
}

/**
 * Interpreters installed under the usual Windows per-user location. The Python
 * that owns PATH is often a different install from the one that has the solver
 * dependencies, so these are worth trying before giving up.
 */
function windowsPythonInstalls(): string[] {
  const roots = [
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Python` : '',
    'C:\\Python',
  ].filter(Boolean)
  const found: string[] = []
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) {
        if (!/^Python3\d*$/i.test(entry)) continue
        const exe = `${root}\\${entry}\\python.exe`
        if (existsSync(exe)) found.push(exe)
      }
    } catch {
      // Directory missing or unreadable - nothing to add from here.
    }
  }
  return found
}

/**
 * Candidate interpreters, most likely first. `ZAI_PYTHON_PATH` is trusted
 * outright - if the operator named one, they know what they are doing.
 */
export function pythonCandidates(plat: NodeJS.Platform = platform()): string[] {
  const explicit = process.env.ZAI_PYTHON_PATH?.trim()
  if (explicit) return [explicit]
  if (plat === 'win32') return ['python', 'python3', 'py', ...windowsPythonInstalls()]
  return ['python3', 'python']
}

// The solver needs patchright (browser), numpy and Pillow (image maths). The
// first `python` on PATH is frequently some other install that has none of
// them, and a refresh that dies on ModuleNotFoundError looks identical to a
// dead account. Probe once, then remember the answer.
let resolvedPythonBin: string | null = null

function pythonBin(): string {
  if (resolvedPythonBin) return resolvedPythonBin
  const explicit = process.env.ZAI_PYTHON_PATH?.trim()
  const candidates = explicit ? [explicit] : pythonCandidates()
  let chosen = candidates[0]
  if (!explicit) {
    for (const bin of candidates) {
      try {
        const probe = spawnSync(bin, ['-c', 'import patchright, numpy, PIL'], {
          timeout: 15000,
          windowsHide: true,
          encoding: 'utf8',
        })
        if (!probe.error && probe.status === 0) {
          chosen = bin
          break
        }
      } catch {
        // Not a usable interpreter - try the next one.
      }
    }
  }
  resolvedPythonBin = chosen
  return chosen
}

/**
 * Vision-model settings for the captcha solver. The UI value wins when it is
 * filled in; process env is the fallback so Docker/secrets still work when the
 * user never opened the settings page.
 */
/**
 * Pure decision rule behind `visionSolverEnv()`: the UI config only wins when it
 * is enabled AND has both a base URL and a key; otherwise process env stands.
 * Exported so the precedence can be unit-tested without touching the store.
 */
export function resolveCaptchaVisionEnv(
  captchaVision: { enabled?: boolean; baseUrl?: string; apiKey?: string; model?: string } | undefined | null,
  env: Record<string, string | undefined>
): Record<string, string> {
  const fromEnv = {
    ZAI_VISION_API_URL: (env.ZAI_VISION_API_URL || '').trim(),
    ZAI_VISION_API_KEY: (env.ZAI_VISION_API_KEY || '').trim(),
    ZAI_VISION_MODEL: (env.ZAI_VISION_MODEL || '').trim(),
  }
  // Trim before the truthiness check: a whitespace-only value must count as
  // empty, otherwise the solver is pointed at a URL that cannot resolve.
  const baseUrl = (captchaVision?.baseUrl || '').trim()
  const apiKey = (captchaVision?.apiKey || '').trim()
  const model = (captchaVision?.model || '').trim()
  if (captchaVision?.enabled && baseUrl && apiKey) {
    return {
      ZAI_VISION_API_URL: baseUrl,
      ZAI_VISION_API_KEY: apiKey,
      ZAI_VISION_MODEL: model || fromEnv.ZAI_VISION_MODEL,
    }
  }
  return fromEnv
}

function visionSolverEnv(): Record<string, string> {
  let cfg: { enabled?: boolean; baseUrl?: string; apiKey?: string; model?: string } | undefined
  try {
    cfg = storeManager.getConfig()?.captchaVision
  } catch {
    // Config unavailable - fall through to env.
    cfg = undefined
  }
  return resolveCaptchaVisionEnv(cfg, process.env)
}

function refreshTimeoutMs(): number {
  return Number(process.env.ZAI_REFRESH_TIMEOUT_MS || 180000)
}

function solverWaitSeconds(): number {
  return Number(process.env.ZAI_REFRESH_WAIT_SECONDS || 60)
}

/**
 * True when we are almost certainly running inside a container, where popping a
 * visible browser open is useless - there is nobody in front of the screen.
 * `env` is injected so tests can exercise the marker without touching process.
 */
export function isContainerRuntime(env: Record<string, string | undefined> = process.env): boolean {
  const marker = (env.C2A_RUNTIME || '').toLowerCase()
  if (marker === 'docker' || marker === 'container') return true
  if (marker === 'desktop' || marker === 'electron') return false
  try {
    return existsSync('/.dockerenv')
  } catch {
    return false
  }
}

/**
 * Human fallback: when the automated slider solve fails, leave the browser open
 * so someone can drag the captcha by hand instead of losing the account.
 *
 * On by default for the desktop app - a real user is sitting there, and a
 * manual drag beats a dead account. Off inside a container, where waiting on a
 * human would just burn the refresh budget. Override either way with
 * ZAI_REFRESH_ALLOW_HUMAN=0|1.
 */
export function resolveAllowHuman(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = (env.ZAI_REFRESH_ALLOW_HUMAN || '').trim().toLowerCase()
  if (explicit === '1' || explicit === 'true' || explicit === 'on' || explicit === 'yes') return true
  if (explicit === '0' || explicit === 'false' || explicit === 'off' || explicit === 'no') return false
  return !isContainerRuntime(env)
}

function allowHumanFallback(): boolean {
  return resolveAllowHuman(process.env)
}

function humanTimeoutSeconds(): number {
  return Number(process.env.ZAI_REFRESH_HUMAN_TIMEOUT || 180)
}

/**
 * Waiting on a human easily outruns the default automation budget, and a killed
 * child would discard a captcha the user just solved. Give human runs room.
 */
function effectiveTimeoutMs(): number {
  if (!allowHumanFallback()) return refreshTimeoutMs()
  const needed = (humanTimeoutSeconds() + 120) * 1000
  return Math.max(refreshTimeoutMs(), needed)
}

/**
 * Every refresh boots a headless Chromium to harvest a captcha param. The prod
 * box has roughly 1GB of RAM, so even two concurrent harvests can OOM it.
 * Cap how many refreshes run at once and queue the rest.
 */
function maxConcurrentRefreshes(): number {
  const configured = Number(process.env.ZAI_REFRESH_MAX_CONCURRENCY)
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1
}

/**
 * After a failed refresh, ignore further attempts for this account for a while.
 * Without it, a wave of 401s across the pool spawns one browser session per
 * request. Set to 0 to disable.
 */
function failureCooldownMs(): number {
  const configured = Number(process.env.ZAI_REFRESH_COOLDOWN_MS)
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 5 * 60 * 1000
}

// Shared across all refresher instances: adapter instances are per-request, but
// dedupe/cooldown/throttling must be process-wide to be effective.
const inFlight = new Map<string, Promise<string | null>>()
const lastFailureAt = new Map<string, number>()
let activeRefreshes = 0
const waitingForSlot: Array<() => void> = []

async function acquireRefreshSlot(): Promise<void> {
  if (activeRefreshes < maxConcurrentRefreshes()) {
    activeRefreshes += 1
    return
  }

  await new Promise<void>((resolve) => waitingForSlot.push(resolve))
}

function releaseRefreshSlot(): void {
  const next = waitingForSlot.shift()
  if (next) {
    // Pass the slot straight to the next waiter; activeRefreshes is unchanged.
    next()
    return
  }
  activeRefreshes -= 1
}

/** Test seam: forget dedupe/cooldown state between cases. */
export function resetZaiRefreshStateForTests(): void {
  inFlight.clear()
  lastFailureAt.clear()
  waitingForSlot.length = 0
  activeRefreshes = 0
}

export type ZaiRefreshError = Error & {
  status?: number
  code?: string
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
  /** Persisted account state for an explicit, permanent credential result. */
  accountStatus?: 'inactive'
}

export type ZaiSigninResult = {
  status: number
  token: string
  cookies: string
  captcha_verify_param?: string
  detail: string
}

export type ParsedSolverOutput =
  | { kind: 'signin'; result: ZaiSigninResult }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

/**
 * When the solver dies it exits non-zero with a Python traceback and no JSON,
 * so the raw `execFile` error only says "Command failed". Surface the tail of
 * the solver output too, otherwise a harvest failure (e.g. "Could not send chat
 * message to trigger captcha" on a revoked token) is invisible in prod logs.
 */
export function solverFailureDetail(stdout: string, stderr: string): string {
  const lines = `${String(stdout || '')}\n${String(stderr || '')}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return sanitizeDetail(lines.slice(-4).join(' | ')) || ''
}

/**
 * Pull the signin result out of the solver's stdout. The solver emits progress
 * logs first and the JSON payload last, so scan upwards from the end.
 */
export function parseSolverOutput(stdout: string): ParsedSolverOutput {
  const lines = String(stdout || '').trim().split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i])
    } catch {
      // Not JSON (a progress log) — keep scanning upwards.
      continue
    }

    if (!isObjectValue(parsed)) continue

    if (parsed.mode === 'signin') {
      return {
        kind: 'signin',
        result: {
          status: Number(parsed.status) || 0,
          token: String(parsed.token || ''),
          cookies: String(parsed.cookies || ''),
          captcha_verify_param:
            typeof parsed.captcha_verify_param === 'string' ? parsed.captcha_verify_param : undefined,
          detail: String(parsed.detail || ''),
        },
      }
    }

    if (typeof parsed.error === 'string' && parsed.error) {
      return { kind: 'error', message: parsed.error }
    }
  }

  return { kind: 'none' }
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sanitizeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!compact) return undefined

  return compact
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/((?:token|cookie|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 300)
}

/**
 * The disposable-mailbox account pool shares one password convention:
 * <local-part>@ (e.g. vision-shack-icy@duck.com -> "vision-shack-icy@",
 * gory-unmixed-rally@525203.xyz -> "gory-unmixed-rally@"). Used only when no
 * password was stored explicitly, so a real password entered through the UI
 * always wins.
 */
export function deriveZaiPassword(email: string): string {
  const normalized = String(email || '').trim()
  const at = normalized.indexOf('@')
  if (at <= 0) return ''
  return `${normalized.slice(0, at)}@`
}

function looksLikeEmail(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export function resolveZaiCredentials(account: Account): { email: string; password: string; derived: boolean } {
  // Accounts created before the email field existed often carry the login in
  // their display name (e.g. "twerp-rut-grinning@duck.com"), so fall back to it
  // rather than leaving un-backfilled instances unable to refresh.
  const nameAsEmail = looksLikeEmail(account.name) ? String(account.name).trim() : ''
  const email = String(account.credentials.email || account.email || nameAsEmail || '').trim()
  const stored = String(account.credentials.password || '').trim()
  if (stored) {
    return { email, password: stored, derived: false }
  }
  return { email, password: deriveZaiPassword(email), derived: true }
}

function createRefreshError(options: {
  message: string
  status: number
  retryable: boolean
  accountFault: boolean
  retryScope?: 'next-account'
  accountStatus?: 'inactive'
}): ZaiRefreshError {
  const error = new Error(options.message) as ZaiRefreshError
  error.status = options.status
  error.code = 'zai_token_refresh_failed'
  error.retryable = options.retryable
  error.accountFault = options.accountFault
  if (options.retryScope) error.retryScope = options.retryScope
  if (options.accountStatus) error.accountStatus = 'inactive'
  return error
}

/**
 * Classify a failed signin. Captcha rejections dominate here and must stay
 * retryable: the param expires quickly and a fresh harvest often succeeds,
 * which is not evidence that the credential is bad.
 */
export function classifyZaiSigninFailure(result: ZaiSigninResult): ZaiRefreshError {
  const detail = sanitizeDetail(result.detail)
  const suffix = detail ? `: ${detail}` : ''
  const haystack = `${detail || ''} ${result.status}`

  if (/captcha|verification|滑块|验证/i.test(haystack)) {
    return createRefreshError({
      message: `Z.ai token refresh failed (captcha rejected)${suffix}`,
      status: 403,
      retryable: true,
      accountFault: false,
    })
  }

  if (/(?:not[\s_-]*registered|unregistered|user[\s_-]*not[\s_-]*found|account[\s_-]*not[\s_-]*found|(?:账号|帐户|用户)(?:未注册|不存在))/i.test(haystack)) {
    return createRefreshError({
      message: `Z.ai account is not registered${suffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
      accountStatus: 'inactive',
    })
  }

  if (/(?:incorrect|invalid|wrong|密码|password|credential)/i.test(haystack) || result.status === 401) {
    return createRefreshError({
      message: `Z.ai credentials were rejected during token refresh${suffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    })
  }

  if (result.status === 429) {
    return createRefreshError({
      message: `Z.ai token refresh was rate limited${suffix}`,
      status: 429,
      // Throttling is a provider-side response, not proof the credential is
      // invalid. Leave the account eligible after the normal pacing window.
      retryable: false,
      accountFault: false,
    })
  }

  if (result.status >= 500) {
    return createRefreshError({
      message: `Z.ai token refresh service failed (HTTP ${result.status})${suffix}`,
      status: 502,
      retryable: true,
      accountFault: false,
    })
  }

  return createRefreshError({
    message: `Z.ai token refresh returned an invalid response (HTTP ${result.status})${suffix}`,
    status: 502,
    retryable: true,
    accountFault: false,
  })
}

function createTransportError(error: unknown): ZaiRefreshError {
  const record = isObjectValue(error) ? error : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = error instanceof Error ? error.message : ''
  const killed = code === 'ETIMEDOUT' || (error as { killed?: boolean })?.killed
  const timedOut = killed || code === 'ECONNABORTED' || /timed?\s*out|timeout/i.test(message)

  return createRefreshError({
    message: timedOut ? 'Z.ai token refresh timed out' : 'Z.ai token refresh solver failed',
    status: timedOut ? 504 : 502,
    retryable: true,
    accountFault: false,
  })
}

function persistInactiveAccount(account: Account, error: ZaiRefreshError): void {
  if (error.accountStatus !== 'inactive') return

  try {
    storeManager.updateAccount(account.id, {
      status: 'inactive',
      errorMessage: error.message,
    })
  } catch (persistError) {
    console.warn('[Z.ai] Failed to persist unregistered account state:', persistError)
  }
}

/**
 * Pure argv builder, exported so the human-fallback wiring is unit-testable.
 * A visible browser is required for a human to drag the captcha, so --headless
 * is dropped when human mode is on; every other run stays headless for Docker.
 */
export function buildSolverSigninArgv(opts: {
  scriptPath: string
  token: string
  accountId: string
  email: string
  password: string
  waitSeconds: number
  human: boolean
  humanTimeout: number
}): string[] {
  return [
    opts.scriptPath,
    '--token', opts.token,
    '--account-id', opts.accountId,
    '--mode', 'signin',
    '--email', opts.email,
    '--password', opts.password,
    '--wait-seconds', String(opts.waitSeconds),
    ...(opts.human ? [] : ['--headless']),
    ...(opts.human
      ? ['--allow-human', '--human-timeout', String(opts.humanTimeout)]
      : []),
  ]
}

function runSolverSignin(args: {
  token: string
  email: string
  password: string
  accountId: string
}): Promise<ZaiSigninResult> {
  return new Promise((resolve, reject) => {
    const argv = buildSolverSigninArgv({
      scriptPath: solverScriptPath(),
      token: args.token,
      accountId: args.accountId,
      email: args.email,
      password: args.password,
      waitSeconds: solverWaitSeconds(),
      human: allowHumanFallback(),
      humanTimeout: humanTimeoutSeconds(),
    })

    const child = execFile(
      pythonBin(),
      argv,
      {
        timeout: effectiveTimeoutMs(),
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...visionSolverEnv() },
      },
      (error, stdout, stderr) => {
        const parsed = parseSolverOutput(String(stdout || ''))

        if (parsed.kind === 'signin') {
          resolve(parsed.result)
          return
        }

        if (parsed.kind === 'error') {
          reject(new Error(parsed.message))
          return
        }

        const combined = `${String(stdout || '')}\n${String(stderr || '')}`
        const detail = solverFailureDetail(String(stdout || ''), String(stderr || ''))

        if (error) {
          console.error('[Z.ai] Signin solver failed:', error.message)
          if (detail) console.error('[Z.ai] Solver output:', detail)
          reject(new Error(`Z.ai signin solver failed: ${error.message}${detail ? ` (${detail})` : ''}`))
          return
        }

        // A missing dependency looks exactly like a dead account unless we say
        // so: the script dies before printing any JSON.
        if (/ModuleNotFoundError|No module named/i.test(combined)) {
          const missing = /No module named '([^']+)'/.exec(combined)?.[1] || 'dependencies'
          reject(
            new Error(
              `Z.ai signin solver is missing Python package "${missing}". Install it for ${pythonBin()} ` +
                `(pip install patchright numpy pillow) or point ZAI_PYTHON_PATH at an interpreter that has it.`
            )
          )
          return
        }

        reject(new Error(`Signin solver produced no JSON result${detail ? `: ${detail}` : ''}`))
      },
    )

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) console.log('[Z.ai] Solver:', text.substring(0, 200))
    })
  })
}

export class ZaiTokenRefresher {
  canRefresh(account: Account): boolean {
    const { email, password } = resolveZaiCredentials(account)
    return Boolean(email && password)
  }

  /**
   * Re-login and persist a fresh JWT. Returns the new token, or null when the
   * account cannot be refreshed from stored credentials.
   */
  async refresh(account: Account): Promise<string | null> {
    const { email, password, derived } = resolveZaiCredentials(account)
    if (!email || !password) {
      console.log('[Z.ai] No email/password stored, skipping credential refresh')
      return null
    }

    const cooldown = failureCooldownMs()
    const failedAt = lastFailureAt.get(account.id)
    if (cooldown > 0 && failedAt !== undefined && Date.now() - failedAt < cooldown) {
      const remainingS = Math.ceil((cooldown - (Date.now() - failedAt)) / 1000)
      console.log(`[Z.ai] Refresh for ${email} is cooling down (${remainingS}s left after last failure)`)
      return null
    }

    const existing = inFlight.get(account.id)
    if (existing) {
      console.log(`[Z.ai] Refresh already in flight for account ${account.id}, waiting...`)
      return existing
    }

    const task = this.runWithRefreshSlot(account, email, password, derived)
    inFlight.set(account.id, task)

    try {
      return await task
    } finally {
      inFlight.delete(account.id)
    }
  }

  private async runWithRefreshSlot(
    account: Account,
    email: string,
    password: string,
    derived: boolean,
  ): Promise<string | null> {
    await acquireRefreshSlot()
    try {
      return await this.doRefresh(account, email, password, derived)
    } catch (error) {
      lastFailureAt.set(account.id, Date.now())
      throw error
    } finally {
      releaseRefreshSlot()
    }
  }

  /** Convenience entry point mirroring QwenAiTokenRefresher's 401 hook. */
  async refreshAfterUnauthorized(account: Account): Promise<string | null> {
    if (!this.canRefresh(account)) return null
    return this.refresh(account)
  }

  private async doRefresh(
    account: Account,
    email: string,
    password: string,
    derived: boolean,
  ): Promise<string | null> {
    console.log(
      `[Z.ai] Refreshing token via /api/v1/auths/signin for ${email}` +
        `${derived ? ' (password derived from email convention)' : ''}`,
    )

    let result: ZaiSigninResult
    try {
      result = await runSolverSignin({
        token: String(account.credentials.token || ''),
        email,
        password,
        accountId: account.id,
      })
    } catch (error) {
      throw createTransportError(error)
    }

    if (!result.token) {
      const refreshError = classifyZaiSigninFailure(result)
      persistInactiveAccount(account, refreshError)
      throw refreshError
    }

    const credentials: Record<string, string> = {
      ...account.credentials,
      token: result.token,
    }
    if (result.cookies) credentials.cookies = result.cookies
    if (result.captcha_verify_param) credentials.captcha_verify_param = result.captcha_verify_param

    const updated = storeManager.updateAccount(account.id, {
      email,
      credentials,
      status: 'active',
      errorMessage: undefined,
    })

    console.log(`[Z.ai] Token refreshed successfully for ${email}`)
    return result.token || updated?.credentials?.token || null
  }
}

export const zaiTokenRefresher = new ZaiTokenRefresher()
