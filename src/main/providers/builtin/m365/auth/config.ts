import axios from 'axios'
import * as crypto from 'crypto'

export const DEFAULT_CLIENT_ID = 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1'
export const FOCI_CLIENT_ID = 'd3590ed6-52b3-4102-aeff-aad2292ab01c'
export const MSA_CONSUMER_CLIENT_ID = '14638111-3389-403d-b206-a6a71d9f8f16'
export const MSA_CONSUMER_TID = '9188040d-6c67-4c5b-b112-36a304b66dad'

export const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com/common'
export const DEFAULT_REDIRECT_URI =
  'https://login.microsoftonline.com/common/oauth2/nativeclient'
export const DEFAULT_SCOPE =
  'openid profile offline_access https://substrate.office.com/sydney/M365-Chat.Read https://substrate.office.com/sydney/sydney.readwrite'

export function getClientId(): string {
  return (
    process.env.M365_BROWSER_CLIENT_ID ||
    process.env.M365_CLIENT_ID ||
    DEFAULT_CLIENT_ID
  )
}

export function getAuthority(): string {
  return (
    process.env.M365_BROWSER_AUTHORITY ||
    process.env.M365_AUTHORITY ||
    DEFAULT_AUTHORITY
  )
}

export function getRedirectUri(): string {
  return (
    process.env.M365_BROWSER_REDIRECT_URI ||
    process.env.M365_REDIRECT_URI ||
    DEFAULT_REDIRECT_URI
  )
}

export function getScope(): string {
  return (
    process.env.M365_BROWSER_SCOPE || process.env.M365_SCOPE || DEFAULT_SCOPE
  )
}

export function getDeviceClientId(): string {
  return process.env.M365_DEVICE_CLIENT_ID || process.env.M365_CLIENT_ID || FOCI_CLIENT_ID
}

export function getDeviceAuthority(): string {
  return process.env.M365_DEVICE_AUTHORITY || process.env.M365_AUTHORITY || DEFAULT_AUTHORITY
}

export function getDeviceScope(): string {
  return process.env.M365_DEVICE_SCOPE || process.env.M365_SCOPE || DEFAULT_SCOPE
}

export function getAuthorizeEndpoint(): string {
  return process.env.M365_AUTHORIZE_ENDPOINT || `${getAuthority()}/oauth2/v2.0/authorize`
}

export function getTokenEndpoint(): string {
  return process.env.M365_TOKEN_ENDPOINT || `${getAuthority()}/oauth2/v2.0/token`
}

export function getDeviceCodeEndpoint(): string {
  return process.env.M365_DEVICE_ENDPOINT || `${getDeviceAuthority()}/oauth2/v2.0/devicecode`
}

export function getDeviceTokenEndpoint(): string {
  return process.env.M365_DEVICE_TOKEN_ENDPOINT || `${getDeviceAuthority()}/oauth2/v2.0/token`
}

export function getTokenOriginCandidates(): string[] {
  const candidates = [(process.env.M365_TOKEN_ORIGIN || '').trim()]
  try {
    candidates.push(new URL(getRedirectUri()).origin)
  } catch {
    // ignore malformed redirect URI
  }
  candidates.push(
    'https://copilot.microsoft.com',
    'https://www.bing.com',
    'https://m365.cloud.microsoft',
    'https://www.office.com'
  )
  return [...new Set(candidates.filter(Boolean))]
}

export function generateVerifier(): string {
  const bytes = crypto.randomBytes(32)
  return bytes.toString('base64url')
}

export function generateChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest()
  return hash.toString('base64url')
}

export interface StringClaims {
  [key: string]: string
}

export function decodeJwtClaims(token: string): StringClaims {
  const parts = token.split('.')
  if (parts.length < 2) {
    throw new Error('Invalid JWT')
  }
  const raw = Buffer.from(parts[1], 'base64url').toString('utf-8')
  const claims = JSON.parse(raw)
  const result: StringClaims = {}
  for (const [key, value] of Object.entries(claims)) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}

export function decodeAccessTokenExp(token: string): number | undefined {
  try {
    const parts = token.split('.')
    if (parts.length < 2) {
      return undefined
    }
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    return typeof claims.exp === 'number' ? claims.exp : undefined
  } catch {
    return undefined
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (v?.trim()) {
      return v
    }
  }
  return ''
}

function extractAadstsCode(description: string): string {
  const prefix = 'AADSTS'
  const start = description.indexOf(prefix)
  if (start < 0) {
    return ''
  }
  let end = start + prefix.length
  while (end < description.length && description[end] >= '0' && description[end] <= '9') {
    end++
  }
  if (end === start + prefix.length) {
    return ''
  }
  return description.substring(start, end)
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType?: string
  scope?: string
  expiresIn?: number
  expiresAt?: number
  email?: string
  displayName?: string
  homeOid?: string
  tenantId?: string
}

interface TokenError extends Error {
  code?: string
  aadsts?: string
  httpStatus?: number
  correlationId?: string
  traceId?: string
}

export async function requestToken(params: URLSearchParams, _endpoint?: string): Promise<TokenSet> {
  const tokenEndpoint = getTokenEndpoint()
  // Candidate header sets: no Origin first (native-style redemption works for
  // most clients), then each known web origin for clients that require
  // cross-origin redemption.
  const headerVariants: Record<string, string>[] = [
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    ...getTokenOriginCandidates().map((origin) => ({
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    })),
  ]
  let lastError: TokenError | null = null

  for (let attempt = 0; attempt < headerVariants.length; attempt++) {
    const index = (preferredTokenOriginIndex + attempt) % headerVariants.length
    const response = await axios.post(tokenEndpoint, params.toString(), {
      headers: headerVariants[index],
      timeout: 30000,
      // OAuth error bodies (invalid_grant, AADSTS*) arrive with HTTP 400;
      // keep them parseable instead of letting axios throw on status alone.
      validateStatus: () => true,
    })
    const tr = response.data as Record<string, string | number | undefined>
    if (tr.error) {
      const error = new Error(
        `${tr.error}: ${tr.error_description || 'Unknown error'}`
      ) as TokenError
      error.code = tr.error as string
      error.aadsts = extractAadstsCode((tr.error_description as string) || '')
      error.httpStatus = response.status
      error.correlationId = (tr.correlation_id as string) || response.headers['client-request-id']
      error.traceId = (tr.trace_id as string) || response.headers['x-ms-request-id']
      // AADSTS90023 marks an Origin/redemption-style mismatch; the accepted
      // shape depends on the client registration, so rotate through the
      // candidates before giving up.
      if (error.aadsts !== '90023' || attempt === headerVariants.length - 1) {
        throw error
      }
      lastError = error
      continue
    }
    preferredTokenOriginIndex = index
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Token endpoint HTTP ${response.status}`)
    }
    if (!tr.access_token) {
      throw new Error(`Token endpoint HTTP ${response.status}: empty access token`)
    }

    return buildTokenSet(tr)
  }
  throw lastError || new Error('Token endpoint failed')
}

let preferredTokenOriginIndex = 0

function buildTokenSet(tr: Record<string, string | number | undefined>): TokenSet {
  const set: TokenSet = {
    accessToken: tr.access_token as string,
    refreshToken: tr.refresh_token as string | undefined,
    idToken: tr.id_token as string | undefined,
    tokenType: tr.token_type as string | undefined,
    scope: tr.scope as string | undefined,
    expiresIn: tr.expires_in as number | undefined,
    expiresAt: Date.now() + ((tr.expires_in as number) || 3600) * 1000,
  }
  try {
    const claims = decodeJwtClaims(set.accessToken)
    set.email = firstNonEmpty(
      claims.unique_name,
      claims.upn,
      claims.preferred_username,
      claims.email
    )
    set.displayName = firstNonEmpty(claims.name, set.email || '')
    set.homeOid = firstNonEmpty(claims.oid, claims.sub)
    set.tenantId = firstNonEmpty(claims.tid, claims.tenant_id)
  } catch {
    // access tokens may be opaque/JWE; fall back to id_token below
  }
  if (set.idToken) {
    try {
      const claims = decodeJwtClaims(set.idToken)
      if (!set.email) {
        set.email = firstNonEmpty(
          claims.preferred_username,
          claims.email,
          claims.upn,
          claims.unique_name
        )
        set.displayName = firstNonEmpty(claims.name, set.email || '')
        set.homeOid = firstNonEmpty(claims.oid, claims.sub, set.homeOid || '')
      }
      set.tenantId = firstNonEmpty(set.tenantId || '', claims.tid, claims.tenant_id)
    } catch {
      // ignore malformed id_token
    }
  }
  return set
}
