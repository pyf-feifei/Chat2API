import axios from 'axios'
import { createHash } from 'crypto'
import type { Account } from '../../store/types'
import { storeManager } from '../../store/store'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000

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

export class QwenAiTokenRefresher {
  isTokenExpiringSoon(token: string, now: number = Date.now()): boolean {
    const payload = decodeJwtPayload(token)
    if (!payload?.exp || typeof payload.exp !== 'number') {
      return true
    }

    return payload.exp * 1000 - now <= REFRESH_THRESHOLD_MS
  }

  async refreshIfNeeded(account: Account): Promise<Account> {
    if (!this.canRefresh(account) || !this.isTokenExpiringSoon(account.credentials.token || '')) {
      return account
    }

    return this.refresh(account)
  }

  async refreshAfterUnauthorized(account: Account): Promise<Account> {
    if (!this.canRefresh(account)) {
      return account
    }

    return this.refresh(account)
  }

  private canRefresh(account: Account): boolean {
    return Boolean(account.credentials.email && account.credentials.password)
  }

  private async refresh(account: Account): Promise<Account> {
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
          Origin: QWEN_AI_BASE,
          Referer: `${QWEN_AI_BASE}/`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        },
        timeout: 15000,
        validateStatus: () => true,
      },
    )

    const token = response.data?.token
    if (response.status !== 200 || !token || typeof token !== 'string') {
      throw new Error(`Qwen AI token refresh failed: HTTP ${response.status}`)
    }

    const updated = storeManager.updateAccount(account.id, {
      email: account.credentials.email,
      credentials: {
        ...account.credentials,
        token,
      },
      status: 'active',
      errorMessage: undefined,
    })

    return updated ? {
      ...updated,
      credentials: {
        ...account.credentials,
        token,
      },
    } : {
      ...account,
      email: account.credentials.email,
      credentials: {
        ...account.credentials,
        token,
      },
      status: 'active',
      errorMessage: undefined,
      updatedAt: Date.now(),
    }
  }
}

export const qwenAiTokenRefresher = new QwenAiTokenRefresher()
