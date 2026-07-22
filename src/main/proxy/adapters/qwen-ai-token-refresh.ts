import axios from 'axios'
import { createHash } from 'crypto'
import type { Account } from '../../store/types'
import { storeManager } from '../../store/store'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000

type SetCookieHeader = string | string[] | undefined

type QwenAiRefreshError = Error & {
  status?: number
  code?: string
  retryable?: boolean
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }

    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function currentTimezoneHeader(): string {
  return new Date().toString().replace(/\s*\(.+\)$/, '')
}

function normalizeSetCookieHeaders(value: SetCookieHeader): string[] {
  if (Array.isArray(value)) {
    return value.filter(header => typeof header === 'string' && header.trim())
  }

  return typeof value === 'string' && value.trim() ? [value] : []
}

function parseCookiePair(value: string): [string, string] | null {
  const pair = value.split(';', 1)[0]?.trim()
  if (!pair) {
    return null
  }

  const separator = pair.indexOf('=')
  if (separator <= 0) {
    return null
  }

  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1)
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    return null
  }

  return [name, cookieValue]
}

export function mergeCookieHeaders(existingCookieHeader: string, setCookieHeader: SetCookieHeader): string {
  const cookies = new Map<string, string>()

  for (const existingCookie of String(existingCookieHeader || '').split(';')) {
    const parsed = parseCookiePair(existingCookie)
    if (parsed) {
      cookies.set(parsed[0], parsed[1])
    }
  }

  for (const header of normalizeSetCookieHeaders(setCookieHeader)) {
    const parsed = parseCookiePair(header)
    if (parsed) {
      cookies.set(parsed[0], parsed[1])
    }
  }

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function hasCookie(cookieHeader: string, name: string): boolean {
  return new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=[^;]+`).test(cookieHeader)
}

export class QwenAiTokenRefresher {
  isTokenExpiringSoon(token: string, now: number = Date.now()): boolean {
    const payload = decodeJwtPayload(token)
    if (!payload?.exp || typeof payload.exp !== 'number') {
      return true
    }

    return payload.exp * 1000 - now <= REFRESH_THRESHOLD_MS
  }

  async refreshIfNeeded(account: Account, signal?: AbortSignal): Promise<Account> {
    if (
      !this.canRefresh(account) ||
      (!this.isTokenExpiringSoon(account.credentials.token || '') && this.hasWebSessionCookie(account))
    ) {
      return account
    }

    return this.refresh(account, signal)
  }

  async refreshAfterUnauthorized(account: Account, signal?: AbortSignal): Promise<Account> {
    if (!this.canRefresh(account)) {
      return account
    }

    return this.refresh(account, signal)
  }

  private canRefresh(account: Account): boolean {
    return Boolean(account.credentials.email && account.credentials.password)
  }

  private hasWebSessionCookie(account: Account): boolean {
    return hasCookie(account.credentials.cookies || account.credentials.cookie || '', 'token')
  }

  private async refresh(account: Account, signal?: AbortSignal): Promise<Account> {
    const response = await axios.post(
      `${QWEN_AI_BASE}/api/v1/auths/signin`,
      {
        email: account.credentials.email,
        password: sha256Hex(account.credentials.password),
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Origin: QWEN_AI_BASE,
          Referer: `${QWEN_AI_BASE}/`,
          source: 'web',
          Version: '0.2.67',
          Timezone: currentTimezoneHeader(),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        },
        timeout: 15000,
        signal,
        validateStatus: () => true,
      },
    )

    const token = response.data?.token
    if (response.status !== 200 || !token || typeof token !== 'string') {
      const responseText = (() => {
        try {
          return JSON.stringify(response.data || {})
        } catch {
          return ''
        }
      })()
      const riskControlled = /FAIL_SYS_USER_VALIDATE|RGV587|risk-control|challenge|captcha|x5sec|baxia|punish/i.test(responseText)
      const error = new Error(`Qwen AI token refresh failed: HTTP ${response.status}`) as QwenAiRefreshError
      error.status = riskControlled ? 403 : response.status === 200 ? 401 : response.status
      error.retryable = false
      if (riskControlled) {
        error.code = 'qwen_ai_risk_control'
      }
      throw error
    }

    const cookies = mergeCookieHeaders(
      account.credentials.cookies || account.credentials.cookie || '',
      response.headers['set-cookie'],
    )
    const credentials = {
      ...account.credentials,
      token,
      ...(cookies ? { cookies } : {}),
    }

    const updated = storeManager.updateAccount(account.id, {
      email: account.credentials.email,
      credentials,
      status: 'active',
      errorMessage: undefined,
    })

    return updated ? {
      ...updated,
      credentials,
    } : {
      ...account,
      email: account.credentials.email,
      credentials,
      status: 'active',
      errorMessage: undefined,
      updatedAt: Date.now(),
    }
  }
}

export const qwenAiTokenRefresher = new QwenAiTokenRefresher()
