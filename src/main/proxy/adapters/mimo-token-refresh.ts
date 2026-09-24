import axios, { type AxiosResponse } from 'axios'
import { execFile, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { platform } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { Account } from '../../store/types.ts'
import { storeManager } from '../../store/store.ts'

/**
 * Mimo serviceToken expires in ~24h and Xiaomi publishes no refresh endpoint.
 * When the operator stores Xiaomi account email+password, "refresh" means
 * re-authenticating through account.xiaomi.com passport (serviceLoginAuth2)
 * and following the STS callback so aistudio.xiaomimimo.com issues a fresh
 * serviceToken. There is no refresh_token grant — only a full password login.
 *
 * Risk control is aggressive: captchaUrl / identity-verify redirects are
 * classified as retryable non-account-fault failures so a challenge does not
 * freeze a healthy pool entry. Pure HTTP passport is often rejected with
 * captcha (70016 / 验证码输入错误); MIMO_REFRESH_MODE=auto then falls back to
 * scripts/mimo-login/login.py — the same headed Chrome flow that solves the
 * Geetest slider and email OTP used for initial account import.
 */

const PASSPORT_BASE = 'https://account.xiaomi.com'
const MIMO_BASE = 'https://aistudio.xiaomimimo.com'
const SID = 'xiaomichatbot'
const DEFAULT_SERVICE_PARAM = JSON.stringify({
  checkSafePhone: false,
  checkSafeAddress: false,
  lsrp_score: 0.0,
})
const MAX_STS_HOPS = 12

type SetCookieHeader = string | string[] | undefined

export type MimoRefreshError = Error & {
  status?: number
  code?: string
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
  accountStatus?: 'inactive'
}

export type MimoPassportChallenge = {
  qs: string
  callback: string
  sign: string
  serviceParam: string
  cookies: string
}

export type MimoPassportAuthResult = {
  status: number
  code: number
  description: string
  location: string
  userId: string
  captchaUrl: string
}

export type MimoRefreshCredentials = {
  service_token: string
  user_id: string
  ph_token: string
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Xiaomi passport responses are `&&&START&&&{json}` or raw JSON. */
export function parsePassportPayload(data: unknown): Record<string, unknown> {
  if (isObjectValue(data)) return data
  const text = String(data || '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return isObjectValue(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function md5Upper(password: string): string {
  return createHash('md5').update(password, 'utf8').digest('hex').toUpperCase()
}

function normalizeSetCookieHeaders(value: SetCookieHeader): string[] {
  if (Array.isArray(value)) {
    return value.filter((header) => typeof header === 'string' && header.trim())
  }
  return typeof value === 'string' && value.trim() ? [value] : []
}

function parseCookiePair(value: string): [string, string] | null {
  const pair = value.split(';', 1)[0]?.trim()
  if (!pair) return null
  const separator = pair.indexOf('=')
  if (separator <= 0) return null
  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1)
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return null
  return [name, cookieValue]
}

export function mergeCookieJar(jar: string, setCookieHeader: SetCookieHeader): string {
  const cookies = new Map<string, string>()
  for (const existing of String(jar || '').split(';')) {
    const parsed = parseCookiePair(existing)
    if (parsed) cookies.set(parsed[0], parsed[1])
  }
  for (const header of normalizeSetCookieHeaders(setCookieHeader)) {
    const parsed = parseCookiePair(header)
    if (parsed) cookies.set(parsed[0], parsed[1])
  }
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function readCookieFromJar(jar: string, name: string): string {
  for (const part of String(jar || '').split(';')) {
    const parsed = parseCookiePair(part)
    if (parsed && parsed[0] === name) return parsed[1]
  }
  return ''
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

function createRefreshError(options: {
  message: string
  status: number
  retryable: boolean
  accountFault: boolean
  retryScope?: 'next-account'
  accountStatus?: 'inactive'
}): MimoRefreshError {
  const error = new Error(options.message) as MimoRefreshError
  error.status = options.status
  error.code = 'mimo_token_refresh_failed'
  error.retryable = options.retryable
  error.accountFault = options.accountFault
  if (options.retryScope) error.retryScope = options.retryScope
  if (options.accountStatus) error.accountStatus = options.accountStatus
  return error
}

/**
 * Xiaomi passport error codes seen in the wild:
 * 70016 = 登录验证失败 (often captcha / risk), 2 = wrong password / unregistered,
 * 70016+identity redirects = step-up verification. Keep challenges retryable.
 */
export function classifyMimoPassportAuth(result: MimoPassportAuthResult): MimoRefreshError {
  const detail = sanitizeDetail(result.description)
  const suffix = detail ? `: ${detail}` : ''
  const haystack = `${detail || ''} ${result.code} ${result.status}`

  if (result.captchaUrl || /captcha|verify|验证|风控|risk/i.test(haystack)) {
    return createRefreshError({
      message: `Mimo token refresh failed (risk-control / captcha required)${suffix}`,
      status: 403,
      retryable: true,
      accountFault: false,
    })
  }

  if (
    result.code === 2
    || /(?:not[\s_-]*registered|unregistered|user[\s_-]*not[\s_-]*found|account[\s_-]*not[\s_-]*found|(?:账号|帐户|用户)(?:未注册|不存在|或密码错误))/i.test(haystack)
  ) {
    return createRefreshError({
      message: `Mimo Xiaomi account is not registered or password was rejected${suffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
      accountStatus: 'inactive',
    })
  }

  if (/(?:incorrect|invalid|wrong|密码|password|credential|登录验证失败|70016)/i.test(haystack) || result.status === 401) {
    // 70016 often means risk-control rather than a bad password — do not
    // permanently disable the account on a first occurrence.
    if (result.code === 70016 || /登录验证失败/i.test(haystack)) {
      return createRefreshError({
        message: `Mimo Xiaomi passport rejected the login challenge (code ${result.code})${suffix}`,
        status: 403,
        retryable: true,
        accountFault: false,
      })
    }
    return createRefreshError({
      message: `Mimo Xiaomi credentials were rejected during token refresh${suffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    })
  }

  if (result.status === 429) {
    return createRefreshError({
      message: `Mimo token refresh was rate limited${suffix}`,
      status: 429,
      retryable: false,
      accountFault: false,
    })
  }

  if (result.status >= 500) {
    return createRefreshError({
      message: `Mimo token refresh service failed (HTTP ${result.status})${suffix}`,
      status: 502,
      retryable: true,
      accountFault: false,
    })
  }

  return createRefreshError({
    message: `Mimo token refresh returned an invalid response (HTTP ${result.status}, code ${result.code})${suffix}`,
    status: 502,
    retryable: true,
    accountFault: false,
  })
}

function createTransportError(error: unknown): MimoRefreshError {
  const message = error instanceof Error ? error.message : ''
  const code = isObjectValue(error) ? String(error.code || '') : ''
  const timedOut = code === 'ECONNABORTED' || /timed?\s*out|timeout/i.test(message)
  return createRefreshError({
    message: timedOut ? 'Mimo token refresh timed out' : `Mimo token refresh request failed${message ? `: ${message}` : ''}`,
    status: timedOut ? 504 : 502,
    retryable: true,
    accountFault: false,
  })
}

export function resolveMimoCredentials(account: Account): { email: string; password: string } {
  const email = String(account.credentials.email || account.email || '').trim()
  const password = String(account.credentials.password || '').trim()
  return { email, password }
}

function browserHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

function requestOptions(): {
  timeout: number
  maxRedirects: 0
  validateStatus: () => boolean
  headers: Record<string, string>
  withXSRFToken?: boolean
} {
  return {
    timeout: 20000,
    maxRedirects: 0,
    validateStatus: () => true,
    headers: browserHeaders(),
  }
}

function headerString(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join('; ')
  return typeof value === 'string' ? value : ''
}

async function fetchPassportChallenge(): Promise<MimoPassportChallenge> {
  const response: AxiosResponse = await axios.get(`${PASSPORT_BASE}/pass/serviceLogin`, {
    ...requestOptions(),
    params: { sid: SID, _json: 'true' },
  })
  const payload = parsePassportPayload(response.data)
  const cookies = mergeCookieJar(
    '',
    (response.headers as Record<string, unknown>)['set-cookie'] as SetCookieHeader,
  )
  return {
    qs: String(payload.qs || ''),
    callback: String(payload.callback || ''),
    sign: String(payload._sign || payload.sign || ''),
    serviceParam: String(payload.serviceParam || DEFAULT_SERVICE_PARAM),
    cookies,
  }
}

async function postServiceLoginAuth2(
  email: string,
  password: string,
  challenge: MimoPassportChallenge,
): Promise<{ result: MimoPassportAuthResult; cookies: string }> {
  const body = new URLSearchParams({
    user: email,
    hash: md5Upper(password),
    sid: SID,
    callback: challenge.callback,
    qs: challenge.qs,
    _sign: challenge.sign,
    _json: 'true',
    serviceParam: challenge.serviceParam,
  })

  const response: AxiosResponse = await axios.post(
    `${PASSPORT_BASE}/pass/serviceLoginAuth2`,
    body.toString(),
    {
      ...requestOptions(),
      headers: {
        ...browserHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: challenge.cookies,
        Referer: `${PASSPORT_BASE}/fe/service/login/password?sid=${SID}`,
        Origin: PASSPORT_BASE,
      },
    },
  )

  const payload = parsePassportPayload(response.data)
  const cookies = mergeCookieJar(
    challenge.cookies,
    (response.headers as Record<string, unknown>)['set-cookie'] as SetCookieHeader,
  )

  return {
    result: {
      status: response.status,
      code: Number(payload.code ?? (response.status === 200 ? 0 : response.status)) || 0,
      description: String(payload.description || payload.desc || ''),
      location: String(payload.location || ''),
      userId: String(payload.userId || payload.user_id || ''),
      captchaUrl: String(payload.captchaUrl || payload.captcha_url || ''),
    },
    cookies,
  }
}

async function followSts(location: string, cookieJar: string): Promise<string> {
  let current = location
  let jar = cookieJar
  const seen = new Set<string>()

  for (let hop = 0; hop < MAX_STS_HOPS; hop++) {
    if (!current || seen.has(current)) break
    seen.add(current)

    let response: AxiosResponse
    try {
      response = await axios.get(current, {
        ...requestOptions(),
        headers: {
          ...browserHeaders(),
          Cookie: jar,
          Referer: `${MIMO_BASE}/`,
        },
        maxRedirects: 0,
      })
    } catch {
      break
    }

    jar = mergeCookieJar(
      jar,
      (response.headers as Record<string, unknown>)['set-cookie'] as SetCookieHeader,
    )

    const locationHeader = headerString(
      (response.headers as Record<string, unknown>).location
      || (response.headers as Record<string, unknown>)['Location'],
    )
    if (!locationHeader) break
    try {
      current = new URL(locationHeader, current).toString()
    } catch {
      break
    }
  }

  return jar
}

function extractRefreshedCookies(
  jar: string,
  previous: Account['credentials'],
): MimoRefreshCredentials | null {
  const serviceToken =
    readCookieFromJar(jar, 'serviceToken')
    || readCookieFromJar(jar, 'xiaomichatbot_serviceToken')
  const userId = readCookieFromJar(jar, 'userId') || readCookieFromJar(jar, 'cUserId')
  const phToken = readCookieFromJar(jar, 'xiaomichatbot_ph')

  const previousService = String(previous.service_token || '').trim()
  const previousUser = String(previous.user_id || '').trim()
  const previousPh = String(previous.ph_token || '').trim()

  const nextService = serviceToken || previousService
  const nextUser = userId || previousUser
  // ph is a longer-lived device cookie; only replace when passport reissues it.
  const nextPh = phToken || previousPh

  if (!nextService || !nextUser || !nextPh) return null
  if (nextService === previousService && nextPh === previousPh && nextUser === previousUser) {
    return null
  }

  return {
    service_token: nextService,
    user_id: nextUser,
    ph_token: nextPh,
  }
}

function failureCooldownMs(): number {
  const configured = Number(process.env.MIMO_REFRESH_COOLDOWN_MS)
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 5 * 60 * 1000
}

const inFlight = new Map<string, Promise<boolean>>()
const lastFailureAt = new Map<string, number>()

/** Test seam: forget dedupe/cooldown state between cases. */
export function resetMimoRefreshStateForTests(): void {
  inFlight.clear()
  lastFailureAt.clear()
}

/** Resolve scripts/mimo-login/login.py across dev / out-server / container layouts. */
export function resolveMimoLoginScriptPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.MIMO_LOGIN_SCRIPT_PATH?.trim()
  if (explicit) return explicit
  const rel = join('scripts', 'mimo-login', 'login.py')
  const candidates: string[] = []
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    let dir = here
    for (let depth = 0; depth < 6; depth += 1) {
      candidates.push(join(dir, rel))
      dir = dirname(dir)
    }
  } catch {
    // import.meta unavailable — absolute candidates only
  }
  candidates.push(join('/app', rel))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1] || join('/app', rel)
}

export function mimoPythonCandidates(plat: NodeJS.Platform = platform()): string[] {
  const explicit = process.env.MIMO_PYTHON_PATH?.trim()
  if (explicit) return [explicit]
  if (plat === 'win32') return ['python', 'python3', 'py']
  return ['python3', 'python']
}

let resolvedPythonBin: string | null = null

function mimoPythonBin(): string {
  if (resolvedPythonBin) return resolvedPythonBin
  const candidates = mimoPythonCandidates()
  let chosen = candidates[0]
  if (!process.env.MIMO_PYTHON_PATH?.trim()) {
    for (const bin of candidates) {
      try {
        const probe = spawnSync(bin, ['-c', 'import patchright'], {
          timeout: 15000,
          windowsHide: true,
          stdio: 'ignore',
        })
        if (!probe.error && probe.status === 0) {
          chosen = bin
          break
        }
      } catch {
        // try next interpreter
      }
    }
  }
  resolvedPythonBin = chosen
  return chosen
}

/** Pure argv builder for scripts/mimo-login/login.py (unit-tested). */
export function buildMimoBrowserLoginArgv(opts: {
  scriptPath: string
  email: string
  password: string
  accountId?: string
  managementUrl?: string
  managementSecret?: string
  waitSeconds: number
  headless: boolean
  human: boolean
  humanTimeout: number
  gmailCode: boolean
  noImport: boolean
}): string[] {
  const argv = [
    opts.scriptPath,
    '--email', opts.email,
    '--password', opts.password,
    '--wait-seconds', String(opts.waitSeconds),
  ]
  if (opts.accountId) argv.push('--account-id', opts.accountId)
  if (opts.managementUrl) argv.push('--management-url', opts.managementUrl)
  if (opts.managementSecret) argv.push('--management-secret', opts.managementSecret)
  if (opts.headless && !opts.human) argv.push('--headless')
  if (opts.human) {
    argv.push('--allow-human', '--human-timeout', String(opts.humanTimeout))
  }
  if (opts.gmailCode) argv.push('--gmail-code')
  else argv.push('--no-gmail-code')
  if (opts.noImport) argv.push('--no-import')
  return argv
}

export type ParsedMimoBrowserLogin =
  | { kind: 'ok'; credentials: MimoRefreshCredentials }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

/** Pull the last JSON result line from login.py stdout (logs come first). */
export function parseMimoBrowserLoginOutput(stdout: string): ParsedMimoBrowserLogin {
  const lines = String(stdout || '').trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!isObjectValue(parsed)) continue
    const kind = String(parsed.kind || '')
    if (kind === 'ok') {
      const service = String(parsed.service_token || '').trim()
      const user = String(parsed.user_id || '').trim()
      const ph = String(parsed.ph_token || '').trim()
      if (service && user && ph) {
        return {
          kind: 'ok',
          credentials: {
            service_token: stripSurroundingQuotes(service),
            user_id: stripSurroundingQuotes(user),
            ph_token: stripSurroundingQuotes(ph),
          },
        }
      }
    }
    if (kind === 'error') {
      return { kind: 'error', message: String(parsed.message || 'browser login failed') }
    }
  }
  return { kind: 'none' }
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** auto = HTTP then browser on risk; browser = slider login only; http = no browser. */
export function resolveMimoRefreshMode(
  env: Record<string, string | undefined> = process.env,
): 'auto' | 'browser' | 'http' {
  const raw = (env.MIMO_REFRESH_MODE || 'auto').trim().toLowerCase()
  if (raw === 'browser' || raw === 'http') return raw
  return 'auto'
}

function browserRefreshTimeoutMs(): number {
  const configured = Number(process.env.MIMO_REFRESH_BROWSER_TIMEOUT_MS)
  return Number.isFinite(configured) && configured >= 15_000
    ? Math.floor(configured)
    : 5 * 60_000
}

function browserWaitSeconds(): number {
  const configured = Number(process.env.MIMO_REFRESH_BROWSER_WAIT_SECONDS)
  return Number.isFinite(configured) && configured >= 15
    ? Math.floor(configured)
    : 90
}

/**
 * Run scripts/mimo-login/login.py: real Chrome → Geetest slide auto-solve →
 * email OTP (Gmail helper) → three mimo cookies on stdout.
 */
export function loginViaBrowserScript(opts: {
  email: string
  password: string
  accountId?: string
}): Promise<MimoRefreshCredentials> {
  const scriptPath = resolveMimoLoginScriptPath()
  const human = (process.env.MIMO_REFRESH_BROWSER_HUMAN || '').trim() === '1'
  const argv = buildMimoBrowserLoginArgv({
    scriptPath,
    email: opts.email,
    password: opts.password,
    accountId: opts.accountId || '',
    managementUrl: process.env.MIMO_MANAGEMENT_URL || '',
    managementSecret: process.env.MIMO_MANAGEMENT_SECRET
      || process.env.CHAT2API_MANAGEMENT_SECRET || '',
    waitSeconds: browserWaitSeconds(),
    headless: !human,
    human,
    humanTimeout: Number(process.env.MIMO_REFRESH_BROWSER_HUMAN_TIMEOUT || 180),
    gmailCode: (process.env.MIMO_REFRESH_BROWSER_GMAIL || '1') !== '0',
    // Cookies are persisted by the refresher via storeManager, not the script.
    noImport: true,
  })

  return new Promise((resolve, reject) => {
    execFile(
      mimoPythonBin(),
      argv,
      {
        timeout: browserRefreshTimeoutMs(),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          MIMO_GMAIL_HELPER: process.env.MIMO_GMAIL_HELPER
            || process.env.MIMO_LOGIN_GMAIL_HELPER || '',
        },
      },
      (error, stdout, stderr) => {
        const out = String(stdout || '')
        const err = String(stderr || '')
        const parsed = parseMimoBrowserLoginOutput(out)

        if (parsed.kind === 'ok') {
          resolve(parsed.credentials)
          return
        }

        const combined = `${out}\n${err}`
        if (/ModuleNotFoundError|No module named/i.test(combined)) {
          const missing = /No module named '([^']+)'/.exec(combined)?.[1] || 'dependencies'
          reject(new Error(
            `Mimo browser login is missing Python package "${missing}". `
            + `Install it for ${mimoPythonBin()} (pip install patchright numpy pillow) `
            + 'or set MIMO_PYTHON_PATH.',
          ))
          return
        }

        const detail = parsed.kind === 'error'
          ? parsed.message
          : (err.trim().split('\n').slice(-3).join(' | ') || error?.message || 'no JSON result')

        if (error && parsed.kind !== 'error') {
          reject(new Error(`Mimo browser login failed: ${detail}`))
          return
        }
        reject(new Error(detail || 'Mimo browser login produced no result'))
      },
    )
  })
}

/** HTTP risk-control errors may be recovered by the headed Geetest+OTP flow. */
export function shouldFallbackToBrowser(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const refreshError = error as MimoRefreshError
  if (refreshError.accountFault) return false
  // Captcha / risk-control / STS miss — the headed login flow can pass them.
  return refreshError.retryable !== false
}

function persistInactiveAccount(account: Account, error: MimoRefreshError): void {
  if (error.accountStatus !== 'inactive') return
  try {
    storeManager.updateAccount(account.id, {
      status: 'inactive',
      errorMessage: error.message,
    })
  } catch (persistError) {
    console.warn('[Mimo] Failed to persist rejected account state:', persistError)
  }
}

/** Full Xiaomi passport password login → fresh serviceToken (+ user/ph). */
export async function loginWithXiaomiPassword(
  email: string,
  password: string,
  previous: Account['credentials'],
): Promise<MimoRefreshCredentials> {
  const challenge = await fetchPassportChallenge()
  const { result, cookies } = await postServiceLoginAuth2(email, password, challenge)

  if (result.code !== 0 || !result.location) {
    throw classifyMimoPassportAuth(result)
  }

  const jar = await followSts(result.location, cookies)
  const refreshed = extractRefreshedCookies(jar, previous)
  if (!refreshed) {
    // Passport accepted the password but STS did not rotate cookies we track.
    // Surface that so the caller can fall back to in-app login instead of
    // treating it as a hard credential failure.
    throw createRefreshError({
      message: 'Mimo passport login succeeded but aistudio did not issue new cookies',
      status: 502,
      retryable: true,
      accountFault: false,
    })
  }

  if (result.userId && !readCookieFromJar(jar, 'userId') && !readCookieFromJar(jar, 'cUserId')) {
    refreshed.user_id = String(result.userId)
  }

  return refreshed
}

export class MimoTokenRefresher {
  canRefresh(account: Account): boolean {
    const { email, password } = resolveMimoCredentials(account)
    return Boolean(email && password)
  }

  /**
   * Re-login with stored Xiaomi email+password and persist fresh cookies.
   * Returns true when new credentials were written to the store.
   */
  async refresh(account: Account): Promise<boolean> {
    const { email, password } = resolveMimoCredentials(account)
    if (!email || !password) {
      console.log('[Mimo] No email/password stored, skipping credential refresh')
      return false
    }

    const cooldown = failureCooldownMs()
    const failedAt = lastFailureAt.get(account.id)
    if (cooldown > 0 && failedAt !== undefined && Date.now() - failedAt < cooldown) {
      const remainingS = Math.ceil((cooldown - (Date.now() - failedAt)) / 1000)
      console.log(`[Mimo] Refresh for ${email} is cooling down (${remainingS}s left after last failure)`)
      return false
    }

    const existing = inFlight.get(account.id)
    if (existing) {
      console.log(`[Mimo] Refresh already in flight for account ${account.id}, waiting...`)
      return existing
    }

    const task = this.doRefresh(account, email, password)
    inFlight.set(account.id, task)
    try {
      return await task
    } finally {
      inFlight.delete(account.id)
    }
  }

  async refreshAfterUnauthorized(account: Account): Promise<boolean> {
    if (!this.canRefresh(account)) return false
    try {
      return await this.refresh(account)
    } catch (error) {
      lastFailureAt.set(account.id, Date.now())
      throw error
    }
  }

  private async doRefresh(account: Account, email: string, password: string): Promise<boolean> {
    const mode = resolveMimoRefreshMode()
    let refreshed: MimoRefreshCredentials | null = null
    let lastError: unknown = null

    if (mode !== 'browser') {
      console.log(`[Mimo] Refreshing serviceToken via Xiaomi passport for ${email}`)
      try {
        refreshed = await loginWithXiaomiPassword(email, password, account.credentials)
      } catch (error) {
        lastError = error
        const fallback = mode === 'auto' && shouldFallbackToBrowser(error)
        if (!fallback) {
          lastFailureAt.set(account.id, Date.now())
          const refreshError = error && typeof error === 'object' && 'code' in error
            ? error as MimoRefreshError
            : createTransportError(error)
          persistInactiveAccount(account, refreshError)
          throw refreshError
        }
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[Mimo] HTTP passport hit risk-control (${detail}); falling back to browser login.py`)
      }
    }

    if (!refreshed) {
      console.log(`[Mimo] Refreshing serviceToken via browser login (Geetest + OTP) for ${email}`)
      try {
        refreshed = await loginViaBrowserScript({
          email,
          password,
          accountId: account.id,
        })
      } catch (error) {
        lastFailureAt.set(account.id, Date.now())
        const refreshError = createRefreshError({
          message: error instanceof Error
            ? `Mimo browser login failed: ${error.message}`
            : 'Mimo browser login failed',
          status: 502,
          retryable: true,
          accountFault: false,
        })
        // Surface HTTP classification when browser could not run either.
        if (lastError && typeof lastError === 'object' && 'code' in lastError) {
          const httpError = lastError as MimoRefreshError
          if (httpError.accountFault) {
            persistInactiveAccount(account, httpError)
            throw httpError
          }
        }
        throw refreshError
      }
    }

    const credentials: Record<string, string> = {
      ...account.credentials,
      service_token: refreshed.service_token,
      user_id: refreshed.user_id,
      ph_token: refreshed.ph_token,
      ...(email ? { email } : {}),
      ...(password ? { password } : {}),
    }

    lastFailureAt.delete(account.id)
    storeManager.updateAccount(account.id, {
      email,
      credentials,
      status: 'active',
      errorMessage: undefined,
    })

    console.log(`[Mimo] serviceToken refreshed successfully for ${email}`)
    return true
  }
}

export const mimoTokenRefresher = new MimoTokenRefresher()
