/**
 * M365 Copilot management OAuth routes.
 *
 * Browser PKCE (work accounts) + device-code (personal MSA) login flows that
 * return credentials ready to store on an m365-copilot account.
 */
import Router from '@koa/router'
import type { Context } from 'koa'
import axios from 'axios'
import crypto from 'crypto'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import {
  generateChallenge,
  generateVerifier,
  getClientId,
  getAuthorizeEndpoint,
  getRedirectUri,
  getScope,
  getTokenEndpoint,
  DEFAULT_CLIENT_ID,
  MSA_CONSUMER_TID,
} from '../../../providers/builtin/m365/auth/config'
import { pollDeviceCode, startDeviceCode } from '../../../providers/builtin/m365/auth/token'

const router = new Router({ prefix: '/v0/management' })

// Personal accounts must mint tokens as the same client the m365.cloud
// microsoft web app uses (c0ab8ce9) with the full sydney v2 permission set;
// the Chathub WS rejects tokens from the narrower ChatAI-only grant.
const CONSUMER_CLIENT_ID = DEFAULT_CLIENT_ID
const CONSUMER_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
const CONSUMER_SCOPE =
  'https://substrate.office.com/sydney/v2/.default openid profile offline_access'

const PENDING_TTL_MS = 10 * 60 * 1000
const PENDING_MAX = 20
const DEVICE_PENDING_MAX = 20

interface PendingAuth {
  verifier: string
  clientId: string
  redirectUri: string
  tokenEndpoint: string
  createdAt: number
}

interface PendingDevice {
  deviceCode: string
  clientId: string
  userCode: string
  interval: number
  expiresAt?: number
  createdAt: number
}

const pendingAuthMap = new Map<string, PendingAuth>()
const pendingDeviceMap = new Map<string, PendingDevice>()

function pruneMap<K, V extends { createdAt: number }>(map: Map<K, V>, ttlMs: number, max: number): void {
  const now = Date.now()
  for (const [key, entry] of map) {
    if (now - entry.createdAt > ttlMs) map.delete(key)
  }
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function prunePendingAuth(): void {
  pruneMap(pendingAuthMap, PENDING_TTL_MS, PENDING_MAX)
}

function prunePendingDevice(): void {
  const now = Date.now()
  for (const [key, entry] of pendingDeviceMap) {
    if ((entry.expiresAt && now >= entry.expiresAt) || now - entry.createdAt > PENDING_TTL_MS) {
      pendingDeviceMap.delete(key)
    }
  }
  pruneMap(pendingDeviceMap, PENDING_TTL_MS, DEVICE_PENDING_MAX)
}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return {}
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
  } catch {
    return {}
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function str(claims: Record<string, unknown>, key: string): string {
  return asString(claims[key])
}

function createErrorResponse(code: string, message: string) {
  return { success: false, error: { code, message } }
}

function credentialsFromTokens(
  accessToken: string,
  refreshToken?: string,
  idToken?: string,
) {
  const accessClaims = decodeClaims(accessToken)
  const idClaims = idToken ? decodeClaims(idToken) : {}
  // The Chathub WS path routes by the account's HOME id. MSA access tokens
  // carry a resource-specific oid (substrate namespace) while the id_token
  // carries the home PUID the endpoint expects; AAD work ids are identical in
  // both, so preferring the id_token is safe for every account species.
  const oid =
    str(idClaims, 'oid') ||
    str(idClaims, 'sub') ||
    str(accessClaims, 'oid') ||
    str(accessClaims, 'sub')
  if (!oid) {
    return null
  }
  const tid =
    str(idClaims, 'tid') || str(accessClaims, 'tid') || MSA_CONSUMER_TID
  const email =
    str(accessClaims, 'preferred_username') ||
    str(accessClaims, 'email') ||
    str(accessClaims, 'upn') ||
    str(accessClaims, 'unique_name') ||
    str(idClaims, 'preferred_username') ||
    str(idClaims, 'email') ||
    str(idClaims, 'upn') ||
    str(idClaims, 'unique_name')
  const name = str(accessClaims, 'name') || str(idClaims, 'name') || email
  const exp =
    typeof accessClaims.exp === 'number'
      ? accessClaims.exp
      : typeof idClaims.exp === 'number'
        ? idClaims.exp
        : undefined
  return {
    credentials: {
      accessToken,
      refreshToken: refreshToken || '',
      oid,
      tid,
    },
    userInfo: { name, email },
    hasRefreshToken: !!refreshToken,
    expiresAt: exp,
  }
}

router.post('/m365/oauth/start', managementAuthMiddleware, async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>
  const accountType = body.accountType === 'work' ? 'work' : 'personal'
  prunePendingAuth()
  const verifier = generateVerifier()
  const challenge = generateChallenge(verifier)
  const state = crypto.randomBytes(8).toString('hex')

  // Personal accounts must use their own app id + copilot redirect; the work
  // flow keeps the configurable office-web client.
  const clientId = accountType === 'work' ? getClientId() : CONSUMER_CLIENT_ID
  const redirectUri = accountType === 'work' ? getRedirectUri() : CONSUMER_REDIRECT_URI
  const scope = accountType === 'work' ? getScope() : CONSUMER_SCOPE

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  pendingAuthMap.set(state, {
    verifier,
    clientId,
    redirectUri,
    tokenEndpoint: getTokenEndpoint(),
    createdAt: Date.now(),
  })
  ctx.body = {
    success: true,
    data: { state, authUrl: `${getAuthorizeEndpoint()}?${params.toString()}` },
  }
})

router.post('/m365/oauth/exchange', managementAuthMiddleware, async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>
  const url = asString(body.url).trim()

  let code = asString(body.code)
  let state = asString(body.state)
  let redirectError = ''

  if (url) {
    const hashIndex = url.indexOf('#')
    const queryIndex = url.indexOf('?')
    const fragment = hashIndex === -1 ? '' : url.slice(hashIndex + 1)
    const query =
      queryIndex === -1
        ? ''
        : url.slice(queryIndex + 1, hashIndex > queryIndex ? hashIndex : undefined)
    const fragmentParams = new URLSearchParams(fragment)
    const queryParams = new URLSearchParams(query)
    code = fragmentParams.get('code') || queryParams.get('code') || code
    state = fragmentParams.get('state') || queryParams.get('state') || state
    redirectError =
      fragmentParams.get('error_description') ||
      fragmentParams.get('error') ||
      queryParams.get('error_description') ||
      queryParams.get('error') ||
      ''
  }

  if (redirectError && !code) {
    ctx.body = createErrorResponse('oauth_redirect_error', decodeURIComponent(redirectError.replace(/\+/g, ' ')))
    return
  }

  if (!state && pendingAuthMap.size === 1) {
    state = pendingAuthMap.keys().next().value as string
  }
  if (!state) {
    ctx.body = createErrorResponse('missing_state', 'No state found; click Login first. / 未找到 state，请先点“登录”发起授权。')
    return
  }

  const pending = pendingAuthMap.get(state)
  if (!pending) {
    ctx.body = createErrorResponse('unknown_state', 'State not found; click Login first. / state 不存在，请先点“登录”发起授权。')
    return
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingAuthMap.delete(state)
    ctx.body = createErrorResponse('state_expired', 'Login session expired; click Login again. / 登录会话已过期，请重新点“登录”。')
    return
  }

  if (!code) {
    ctx.body = createErrorResponse(
      'missing_code',
      'No code in the redirect URL. Copy the FULL URL shown on the sign-in success page. / 跳转地址里没有 code，请完整复制登录成功页显示的地址。',
    )
    return
  }

  try {
    const response = await axios.post(
      pending.tokenEndpoint,
      new URLSearchParams({
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code,
        grant_type: 'authorization_code',
        code_verifier: pending.verifier,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
        timeout: 30000,
      },
    )
    const token = response.data as {
      access_token?: string
      refresh_token?: string
      id_token?: string
      error?: string
      error_description?: string
    }

    if (!token.access_token) {
      ctx.body = createErrorResponse(
        token.error || 'token_exchange_failed',
        `${token.error || 'token_exchange_failed'}: ${token.error_description || 'no access_token returned'}`,
      )
      return
    }

    const filled = credentialsFromTokens(token.access_token, token.refresh_token, token.id_token)
    if (!filled) {
      ctx.body = createErrorResponse('missing_oid', 'Could not read oid/sub from access token or id_token. / 无法从 access token / id_token 读取 oid/sub。')
      return
    }

    pendingAuthMap.delete(state)
    ctx.body = { success: true, data: filled }
  } catch (error) {
    ctx.body = createErrorResponse(
      'exchange_failed',
      error instanceof Error ? error.message : 'Token exchange request failed',
    )
  }
})

router.post('/m365/oauth/device/start', managementAuthMiddleware, async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>
  const accountType = body.accountType === 'work' ? 'work' : 'personal'
  prunePendingDevice()
  try {
    const started = await startDeviceCode(
      accountType === 'personal' ? { clientId: CONSUMER_CLIENT_ID, scope: CONSUMER_SCOPE } : {},
    )
    const sessionId = crypto.randomBytes(8).toString('hex')
    pendingDeviceMap.set(sessionId, {
      deviceCode: started.deviceCode,
      clientId: accountType === 'personal' ? CONSUMER_CLIENT_ID : '',
      userCode: started.userCode,
      interval: started.interval,
      expiresAt: started.expiresAt,
      createdAt: Date.now(),
    })
    ctx.body = {
      success: true,
      data: {
        sessionId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete:
          started.verificationUriComplete ||
          `${started.verificationUri}?otc=${encodeURIComponent(started.userCode)}`,
        message: started.message,
        expiresIn: started.expiresIn,
        interval: started.interval,
      },
    }
  } catch (error) {
    ctx.body = createErrorResponse(
      'device_start_failed',
      error instanceof Error ? error.message : 'Failed to start device code login',
    )
  }
})

router.post('/m365/oauth/device/poll', managementAuthMiddleware, async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>
  const sessionId = asString(body.sessionId).trim()
  if (!sessionId) {
    ctx.body = createErrorResponse('missing_session', 'Missing device login session. / 缺少设备登录会话。')
    return
  }
  prunePendingDevice()
  const pending = pendingDeviceMap.get(sessionId)
  if (!pending) {
    ctx.body = createErrorResponse('unknown_session', 'Device login session not found or expired. Click Device Login again. / 设备登录会话不存在或已过期，请重新开始。')
    return
  }
  if (pending.expiresAt && Date.now() >= pending.expiresAt) {
    pendingDeviceMap.delete(sessionId)
    ctx.body = createErrorResponse('device_expired', 'Device code expired. Click Device Login again. / 设备代码已过期，请重新开始。')
    return
  }
  try {
    const polled = await pollDeviceCode(
      pending.deviceCode,
      pending.clientId ? { clientId: pending.clientId } : {},
    )
    if (polled.pending) {
      ctx.body = {
        success: true,
        data: {
          status: 'pending',
          interval: polled.slowDown ? Math.max(pending.interval, 5) + 5 : pending.interval,
        },
      }
      return
    }
    const tokenSet = polled.tokenSet
    if (!tokenSet?.accessToken) {
      ctx.body = createErrorResponse('device_poll_failed', 'Device login returned no access token.')
      return
    }
    const filled = credentialsFromTokens(tokenSet.accessToken, tokenSet.refreshToken, tokenSet.idToken)
    if (!filled) {
      ctx.body = createErrorResponse('missing_oid', 'Could not read oid/sub from access token or id_token. / 无法从 access token / id_token 读取 oid/sub。')
      return
    }
    pendingDeviceMap.delete(sessionId)
    ctx.body = {
      success: true,
      data: {
        status: 'succeeded',
        ...filled,
      },
    }
  } catch (error) {
    pendingDeviceMap.delete(sessionId)
    ctx.body = createErrorResponse(
      'device_poll_failed',
      error instanceof Error ? error.message : 'Device login polling failed',
    )
  }
})

export default router