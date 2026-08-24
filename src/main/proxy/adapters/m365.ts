/**
 * M365 Copilot adapter.
 *
 * Bridges OpenAI-format requests to the M365 Copilot ChatHub transports and
 * owns the account credential lifecycle (refresh, invalidation, persistence).
 */
import type { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest } from '../types'
import {
  decodeAccessTokenExp,
  MSA_CONSUMER_CLIENT_ID,
  MSA_CONSUMER_TID,
  type TokenSet,
} from '../../providers/builtin/m365/auth/config'
import { refresh } from '../../providers/builtin/m365/auth/token'
import { storeManager } from '../../store/store'

const REFRESH_BUFFER_MS = 5 * 60 * 1000

const refreshPromiseMap = new Map<string, Promise<TokenSet>>()
const invalidatedAccessTokenMap = new Map<string, string>()

export interface M365ChatCredentials {
  accessToken: string
  oid: string
  tid: string
}

export class M365Adapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  static isM365Provider(provider: Provider): boolean {
    return provider.id === 'm365-copilot' || provider.name.toLowerCase().includes('m365')
  }

  validateAccount(): { valid: boolean; error?: string } {
    const creds = this.getCredentials()
    if (creds.refreshToken) {
      return { valid: true }
    }
    if (!creds.accessToken) {
      return { valid: false, error: 'Missing access token' }
    }
    if (!creds.oid) {
      return { valid: false, error: 'Missing OID (Object ID)' }
    }
    if (!creds.tid) {
      return { valid: false, error: 'Missing TID (Tenant ID)' }
    }
    return { valid: true }
  }

  refreshAccountSnapshot(): void {
    const latest = storeManager.getAccountById(this.account.id, true)
    if (latest) {
      this.account = latest
    }
  }

  getCredentials(): Account['credentials'] {
    return this.account.credentials || {}
  }

  static isAccessTokenUsable(accessToken: string | undefined): boolean {
    if (!accessToken) return false
    const exp = decodeAccessTokenExp(accessToken)
    if (exp === undefined) return true
    return Date.now() < exp * 1000 - REFRESH_BUFFER_MS
  }

  invalidateAccessToken(rejectedAccessToken: string): void {
    if (rejectedAccessToken) {
      invalidatedAccessTokenMap.set(this.account.id, rejectedAccessToken)
    }
  }

  private persistTokenSet(set: TokenSet): void {
    const credentials = { ...this.getCredentials() }
    credentials.accessToken = set.accessToken
    if (set.refreshToken) credentials.refreshToken = set.refreshToken
    if (set.homeOid) credentials.oid = set.homeOid
    if (set.tenantId) credentials.tid = set.tenantId
    storeManager.updateAccount(this.account.id, { credentials })
    invalidatedAccessTokenMap.delete(this.account.id)
    this.refreshAccountSnapshot()
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    // A concurrent request may already have rotated the refresh token; the
    // newer token avoids an intermittent invalid_grant.
    this.refreshAccountSnapshot()
    const latestRefreshToken = this.getCredentials().refreshToken
    if (latestRefreshToken && latestRefreshToken !== refreshToken) {
      refreshToken = latestRefreshToken
    }

    let refreshPromise = refreshPromiseMap.get(refreshToken)
    if (!refreshPromise) {
      // Consumer (MSA) tokens only refresh against their own app id; the
      // default/FOCI clients answer with AADSTS9002313 for them.
      const tid = this.getCredentials().tid
      const clientId = tid === MSA_CONSUMER_TID ? MSA_CONSUMER_CLIENT_ID : undefined
      refreshPromise = refresh(refreshToken, clientId)
      refreshPromiseMap.set(refreshToken, refreshPromise)
    }

    try {
      const set = await refreshPromise
      this.persistTokenSet(set)
      return set
    } finally {
      if (refreshPromiseMap.get(refreshToken) === refreshPromise) {
        refreshPromiseMap.delete(refreshToken)
      }
    }
  }

  async acquireCredentials(forceRefresh = false): Promise<M365ChatCredentials> {
    this.refreshAccountSnapshot()
    const credentials = this.getCredentials()

    const invalidated = invalidatedAccessTokenMap.get(this.account.id)
    if (invalidated) {
      if (credentials.accessToken && invalidated !== credentials.accessToken) {
        invalidatedAccessTokenMap.delete(this.account.id)
      } else {
        forceRefresh = true
      }
    }

    if (!forceRefresh && M365Adapter.isAccessTokenUsable(credentials.accessToken)) {
      return {
        accessToken: credentials.accessToken,
        oid: credentials.oid || '',
        tid: credentials.tid || '',
      }
    }

    if (credentials.refreshToken) {
      const set = await this.refreshAccessToken(credentials.refreshToken)
      return {
        accessToken: set.accessToken,
        oid: set.homeOid || credentials.oid || '',
        tid: set.tenantId || credentials.tid || '',
      }
    }

    if (credentials.accessToken) {
      return {
        accessToken: credentials.accessToken,
        oid: credentials.oid || '',
        tid: credentials.tid || '',
      }
    }

    throw new Error('M365 access token expired; re-authenticate this account')
  }

  transformRequest(request: ChatCompletionRequest): any {
    const lastUserMessage = this.extractLastUserMessage(request.messages)

    if (!lastUserMessage) {
      throw new Error('No user message found in request')
    }

    return {
      text: lastUserMessage,
      tone: 'magic',
      conversationId: undefined,
      sessionId: undefined,
      attachments: this.extractAttachments(request.messages),
      tools: request.tools || [],
      toolChoice: request.tool_choice,
    }
  }

  extractLastUserMessage(messages: Array<{ role: string; content: unknown }>): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          return msg.content
        }
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p: any) => p.type === 'text')
          if (textPart && typeof textPart.text === 'string') {
            return textPart.text
          }
        }
      }
    }
    return null
  }

  extractAttachments(messages: Array<{ role: string; content: unknown }>): unknown[] {
    const attachments: unknown[] = []
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === 'image_url' && part.image_url) {
            attachments.push({
              type: 'image',
              mimeType: 'image/png',
              url: part.image_url.url,
              name: 'image.png',
            })
          }
        }
      }
    }
    return attachments
  }

  transformResponse(chatHubResult: { text?: string }, requestModel: string): any {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: chatHubResult.text || '',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    }
  }

  transformStreamChunk(chunk: { text?: string }, requestModel: string): any {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [
        {
          index: 0,
          delta: {
            content: chunk.text || '',
          },
          finish_reason: null,
        },
      ],
    }
  }
}

interface ChatCompletionRequest {
  messages: Array<{ role: string; content: unknown }>
  tools?: unknown[]
  tool_choice?: unknown
}
