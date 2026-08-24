import axios from 'axios'
import {
  type TokenSet,
  getClientId,
  getDeviceClientId,
  getDeviceScope,
  getDeviceAuthority,
  getDeviceCodeEndpoint,
  getDeviceTokenEndpoint,
  requestToken,
} from './config'

export async function refresh(refreshToken: string, clientId?: string): Promise<TokenSet> {
  const params = new URLSearchParams({
    client_id: clientId || getClientId(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  return requestToken(params)
}

const axiosFormConfig = {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  timeout: 30000,
  validateStatus: () => true,
}

export interface DeviceCodeStart {
  userCode: string
  deviceCode: string
  verificationUri?: string
  verificationUriComplete?: string
  message?: string
  expiresIn?: number
  interval: number
  expiresAt?: number
}

export async function startDeviceCode(options: { clientId?: string; scope?: string } = {}): Promise<DeviceCodeStart> {
  const clientId = options.clientId || getDeviceClientId()
  const scope = options.scope || getDeviceScope()
  const params = new URLSearchParams({ client_id: clientId, scope })
  const response = await axios.post(getDeviceCodeEndpoint(), params.toString(), axiosFormConfig)
  const dr = response.data as Record<string, string | number | undefined>
  if (dr.error) {
    throw new Error(`${String(dr.error)}: ${dr.error_description || 'Unknown error'}`)
  }
  if (!dr.device_code || !dr.user_code) {
    throw new Error('Invalid device code response: ' + JSON.stringify(dr))
  }
  const interval = (dr.interval as number) > 0 ? (dr.interval as number) : 5
  return {
    userCode: dr.user_code as string,
    deviceCode: dr.device_code as string,
    verificationUri: dr.verification_uri as string | undefined,
    verificationUriComplete: dr.verification_uri_complete as string | undefined,
    message: dr.message as string | undefined,
    expiresIn: dr.expires_in as number | undefined,
    interval,
    expiresAt: Date.now() + (dr.expires_in as number) * 1000,
  }
}

export interface DevicePollResult {
  pending: boolean
  slowDown?: boolean
  tokenSet?: TokenSet
}

export async function pollDeviceCode(
  deviceCode: string,
  options: { clientId?: string } = {}
): Promise<DevicePollResult> {
  const clientId = options.clientId || getDeviceClientId()
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  })
  const response = await axios.post(getDeviceTokenEndpoint(), params.toString(), axiosFormConfig)
  const tr = response.data as Record<string, string | number | undefined>
  switch (tr.error) {
    case '':
    case undefined:
      break
    case 'authorization_pending':
      return { pending: true }
    case 'slow_down':
      return { pending: true, slowDown: true }
    case 'expired_token':
    case 'authorization_declined':
    case 'bad_verification_code':
      throw new Error(`${String(tr.error)}: ${tr.error_description || 'Unknown error'}`)
    default:
      if (!tr.access_token) {
        throw new Error(`${String(tr.error)}: ${tr.error_description || 'Unknown error'}`)
      }
  }
  if (!tr.access_token) {
    throw new Error('Token endpoint returned no access token')
  }
  const set: TokenSet = {
    accessToken: tr.access_token as string,
    refreshToken: tr.refresh_token as string | undefined,
    idToken: tr.id_token as string | undefined,
    tokenType: tr.token_type as string | undefined,
    scope: tr.scope as string | undefined,
    expiresIn: tr.expires_in as number | undefined,
    expiresAt: Date.now() + ((tr.expires_in as number) || 3600) * 1000,
  }
  return { tokenSet: set, pending: false }
}
