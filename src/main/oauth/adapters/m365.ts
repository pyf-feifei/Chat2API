/**
 * M365 Copilot OAuth Adapter
 * 
 * Handles Microsoft 365 Copilot authentication via OAuth flows.
 * M365 uses device-code (personal MSA) and PKCE browser (work/school) flows.
 */

import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  AdapterConfig,
  CredentialInfo,
} from '../types'
import { refresh } from '../../providers/builtin/m365/auth/token'
import { refresh } from '../../providers/builtin/m365/auth/token'

export class M365Adapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'm365-copilot',
      authMethods: ['oauth'],
      loginUrl: 'https://m365.cloud.microsoft',
      apiUrl: 'https://substrate.office.com',
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'm365-copilot',
      error: 'Use management API endpoints /v0/management/m365/oauth/start or /v0/management/m365/oauth/device/start',
    }
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const accessToken = credentials['accessToken'] || credentials['access_token']
    
    if (!accessToken) {
      return {
        valid: false,
        error: 'Missing access token',
      }
    }

    try {
      // Decode JWT to validate expiration
      const parts = accessToken.split('.')
      if (parts.length < 2) {
        return { valid: false, error: 'Invalid JWT format' }
      }
      
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
      const exp = payload.exp
      if (exp && exp * 1000 < Date.now()) {
        return { valid: false, error: 'Token expired' }
      }

      return {
        valid: true,
        tokenType: 'access',
        accountInfo: {
          userId: payload.oid,
          email: payload.preferred_username || payload.email,
        },
      }
    } catch (error) {
      return { valid: false, error: 'Failed to decode token' }
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const refreshToken = credentials['refreshToken'] || credentials['refresh_token']
    if (!refreshToken) {
      return null
    }

    try {
      const tokenSet = await refresh(refreshToken)
      
      return {
        type: 'access',
        value: tokenSet.accessToken,
        extra: {
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          oid: tokenSet.homeOid,
          tid: tokenSet.tenantId,
        },
      }
    } catch (error) {
      return null
    }
  }

  protected async processCallback(): Promise<void> {
    // M365 uses device-code and PKCE flows, not traditional OAuth callback
  }
}

export default M365Adapter
