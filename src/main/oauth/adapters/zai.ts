/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const ZAI_API_BASE = 'https://chat.z.ai'
const X_FE_VERSION = 'prod-fe-1.1.92'
const ZAI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN',
  'Cache-Control': 'no-cache',
  Origin: ZAI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': ZAI_USER_AGENT,
  'X-FE-Version': X_FE_VERSION,
  'X-Region': 'domestic',
}

export class ZaiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'zai',
      authMethods: ['manual'],
      loginUrl: ZAI_API_BASE,
      apiUrl: ZAI_API_BASE,
    })
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'zai',
          error: validation.error || 'Token validation failed',
        }
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        success: false,
        providerId,
        providerType: 'zai',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (Z.ai does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Z.ai does not support OAuth callback
  }

  /**
   * Validate token validity
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    
    if (!token) {
      return {
        valid: false,
        error: 'Token cannot be empty',
      }
    }
    
    if (token.startsWith('eyJ') && token.split('.').length === 3) {
      try {
        const parts = token.split('.')
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
        
        // Reject guest accounts
        if (payload.email && payload.email.includes('@guest.com')) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }

        // Check JWT expiry
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          return {
            valid: false,
            error: 'Token has expired, please re-login to get a fresh token',
          }
        }
        
        if (payload && payload.id) {
          const expiresIn = payload.exp ? Math.round((payload.exp * 1000 - Date.now()) / 1000) : undefined
          return {
            valid: true,
            tokenType: 'access',
            accountInfo: {
              userId: payload.id,
              email: payload.email || '',
              name: payload.email || payload.id,
            },
          }
        }
      } catch {
        return {
          valid: false,
          error: 'Invalid JWT token',
        }
      }
    }
    
    return {
      valid: false,
      error: 'Token is invalid',
    }
  }

  /**
   * Refresh token via in-app browser login
   * Z.ai uses JWT from browser cookies - no refresh_token endpoint exists.
   * This opens an in-app browser for the user to re-login and extracts the new cookie token.
   */
  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    try {
      const { inAppLoginManager } = await import('../inAppLogin')
      const result = await inAppLoginManager.startLogin({
        providerId: this.config.providerId || 'zai',
        providerType: 'zai',
        timeout: 120000,
      })
      if (result.success && result.credentials?.token) {
        return { token: result.credentials.token }
      }
      return null
    } catch {
      return null
    }
  }
}
