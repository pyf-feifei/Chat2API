/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createBaseChunk,
} from '../utils/streamToolHandler'
import { getProviderToolProfile, type ProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import { getToolProtocol, hasRejectedToolCallBlock } from '../toolCalling/protocols'
import { isColonTerminatedShortAnswer, isProgressStyleManagedAnswer, isToolDenialManagedAnswer } from './qwenAiProgressIntent.ts'
import { isClientCancellationError } from '../utils/errors'
import {
  hasManagedWorkflowCompletionMarker,
  requiresManagedWorkflowCompletionMarker,
} from '../toolCalling/workflowCompletion'
import type { ToolCallingPlan } from '../toolCalling/types'
import { ZaiFileUploader, ZaiFileReference, ZaiUploadedFile, extractFileFromContent, collectFileParts } from './zai-files'
import { solveCaptchaAndUpdateAccount, isCaptchaRequiredError } from './zai-captcha-solver'
import { checkoutWebshareProxyAgent, webshareProxyUrlForLog } from '../webshareProxy'

const TOKEN_EXPIRY_WARNING_MS = 5 * 60 * 1000 // 5 minutes

const ZAI_FALLBACK_ORIGIN = 'https://chat.z.ai'
const ZAI_FALLBACK_API_ROOT = 'https://chat.z.ai/api'
const ZAI_FALLBACK_CHAT_PATH = '/v2/chat/completions'
const ZAI_FALLBACK_HOST = 'chat.z.ai'
const ZAI_FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const ZAI_FALLBACK_FE_VERSION = 'prod-fe-1.1.93'
const ZAI_FALLBACK_LANGUAGE = 'zh-CN'
const ZAI_FALLBACK_TIMEZONE = 'Asia/Shanghai'
const ZAI_FALLBACK_PAGE_TITLE = 'Z.ai - Free AI Chatbot & Agent powered by GLM-5 & GLM-4.7'
const ZAI_SIGNATURE_WINDOW_MS = 5 * 60 * 1000
// The z.ai web frontend signs chat requests with this shared key; deployments can rotate it via env.
const ZAI_SIGNATURE_SECRET = zaiStringEnv('CHAT2API_ZAI_SIGNATURE_SECRET', 'key-@@@@)))()((9))-xxxx&&&%%%%%')
const ZAI_CHAT_TIMEOUT_MS = zaiNumberEnv('CHAT2API_ZAI_REQUEST_TIMEOUT_MS', 120000)
const ZAI_CONTROL_TIMEOUT_MS = zaiNumberEnv('CHAT2API_ZAI_CONTROL_TIMEOUT_MS', 15000)
const ZAI_DELETE_ALL_TIMEOUT_MS = zaiNumberEnv('CHAT2API_ZAI_DELETE_ALL_TIMEOUT_MS', 30000)

/**
 * Managed workflow continuation budget (mirrors the Qwen default of 1):
 * how many times a dangling managed-tool answer is recovered with a follow-up
 * generation instead of being delivered as a silent workflow stall.
 */
export function zaiWorkflowContinuationAttemptsFromEnv(): number {
  const raw = process.env.CHAT2API_ZAI_WORKFLOW_CONTINUATION_ATTEMPTS
  if (raw === undefined || raw.trim() === '' || /^auto$/i.test(raw.trim())) return 1
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) return 1
  return value
}

/** Absolute wall-clock budget across all continuation rounds of one request. */
export function zaiWorkflowContinuationTimeoutMsFromEnv(): number {
  return zaiNumberEnv('CHAT2API_ZAI_WORKFLOW_CONTINUATION_TIMEOUT_MS', 180000)
}

/**
 * Idle watchdog for the upstream SSE stream (mirrors the Qwen watchdog that
 * proved a healthy thinking stream never stays silent past ~76s). A fully
 * silent upstream for this long is a stalled generation, not a slow one;
 * 0 disables the watchdog.
 */
function zaiStreamIdleTimeoutMsFromEnv(): number {
  const raw = Number(process.env.CHAT2API_ZAI_STREAM_IDLE_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw < 0) return 180000
  return Math.floor(raw)
}

/**
 * Debug: log the first raw upstream `chat:completion` frames of each stream
 * (Qwen parity with CHAT2API_QWEN_AI_DEBUG_REQUEST). Used to observe the
 * upstream event shape (message id placement) without guessing.
 */
function zaiDebugStreamFromEnv(): boolean {
  return zaiBooleanEnv('CHAT2API_ZAI_DEBUG_STREAM', false)
}

let zaiDebugFrameCounter = 0

function zaiStringEnv(name: string, fallback: string): string {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.trim()
}

function zaiNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.floor(raw)
}

function zaiHeader(provider: Provider, name: string): string | undefined {
  const headers = provider.headers || {}
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      const text = String(value ?? '').trim()
      if (text) return text
    }
  }
  return undefined
}

function zaiTimezone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (resolved) return resolved
  } catch {
    // fall through to env/fallback below
  }
  return zaiStringEnv('CHAT2API_ZAI_TIMEZONE', ZAI_FALLBACK_TIMEZONE)
}

function zaiTimezoneOffsetMinutes(): number {
  // Date.getTimezoneOffset() matches the sign convention used by the z.ai web
  // client (UTC+8 reports -480).
  return new Date().getTimezoneOffset()
}

const SEARCH_CITATION_PATTERN = '【turn\\d+search\\d+】'
const SEARCH_CITATION_PARTIAL_START_PATTERN = '【turn\\d+search\\d+$'
const SEARCH_CITATION_PARTIAL_END_PATTERN = '^】'
const SEARCH_CITATION_LOOSE_PATTERN = '【[^】]*turn\\d+search\\d+[^】]*】'
const SEARCH_CITATION_BRACKET_START = '【'
const SEARCH_CITATION_BRACKET_END = '】'

function cleanSearchCitations(text: string): string {
  return text.replace(new RegExp(SEARCH_CITATION_PATTERN, 'g'), '')
}

function cleanSearchCitationsWithBuffer(text: string, buffer: { value: string }): string {
  const combined = buffer.value + text
  
  // First try to match complete citations
  let cleaned = combined.replace(new RegExp(SEARCH_CITATION_LOOSE_PATTERN, 'g'), '')
  
  // Check if there's an opening bracket at the end that might start a citation
  const lastOpenBracket = cleaned.lastIndexOf(SEARCH_CITATION_BRACKET_START)
  if (lastOpenBracket !== -1) {
    const afterBracket = cleaned.slice(lastOpenBracket)
    // Check if it looks like a citation pattern
    if (afterBracket.includes('turn') || afterBracket.includes('search')) {
      // Keep the partial citation in buffer
      buffer.value = afterBracket
      cleaned = cleaned.slice(0, lastOpenBracket)
    } else if (!afterBracket.includes(SEARCH_CITATION_BRACKET_END)) {
      // Opening bracket without closing, might be a citation
      buffer.value = afterBracket
      cleaned = cleaned.slice(0, lastOpenBracket)
    } else {
      buffer.value = ''
    }
  } else {
    buffer.value = ''
  }
  
  return cleaned
}

interface ZaiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like web search, thinking mode) */
  originalModel?: string
  messages: ZaiMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | boolean
  thinking_budget?: number
  deep_research?: boolean
  chatId?: string
  parentMessageId?: string
  files?: any[]
}

const ZAI_REQUEST_MAX_BYTES_DEFAULT = 90 * 1024
const ZAI_TRANSCRIPT_TAIL_BYTES = 8 * 1024

function zaiBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

export function zaiTranscriptUploadEnabled(): boolean {
  return zaiBooleanEnv('CHAT2API_ZAI_TRANSCRIPT_UPLOAD_ENABLED', true)
}

function zaiRequestMaxBytesFromEnv(): number {
  const raw = Number(process.env.CHAT2API_ZAI_REQUEST_MAX_BYTES)
  if (!Number.isFinite(raw) || raw < 0) return ZAI_REQUEST_MAX_BYTES_DEFAULT
  return Math.floor(raw)
}

type ZaiReasoningLevel = 'low' | 'high' | 'max'

/** Map OpenAI-style effort to z.ai's web enum (low / high / max). */
function zaiReasoningEffortLevel(
  effort: 'low' | 'medium' | 'high' | boolean | undefined,
): ZaiReasoningLevel | undefined {
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'high'
  if (effort === 'high') return 'max'
  return undefined
}

function renderZaiTranscript(messages: ZaiMessage[]): string {
  return messages
    .map((msg) => {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      return `${msg.role}: ${text}`
    })
    .join('\n')
}

function zaiTranscriptTail(transcript: string, maxBytes: number): string {
  const buf = Buffer.from(transcript, 'utf8')
  if (buf.byteLength <= maxBytes) return transcript
  return buf.subarray(buf.byteLength - maxBytes).toString('utf8')
}

/** Flatten managed tool history into the provider tool profile wire format. */
function normalizeZaiToolMessage(msg: any, toolProfile: ProviderToolProfile): ZaiMessage {
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: toolProfile.formatAssistantToolCalls(msg.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))),
    }
  }
  if (msg.role === 'tool' && msg.tool_call_id) {
    return {
      role: 'user',
      content: toolProfile.formatToolResult({
        toolCallId: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
        isError: msg.is_error === true,
      }),
    }
  }
  return msg
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

export class ZaiAdapter {
  private provider: Provider
  private account: Account
  private token: string | null = null
  private captchaRetryAttempted: boolean = false
  private useWebshareProxy = false
  private lastWebshareProxyUrl: string | undefined = undefined

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  /**
   * Route this adapter's upstream chat POST through the webshare pool. Used
   * by the forwarder as the recovery lever for exit-IP WAF verdicts
   * (zai_waf_405_block); no-op when the pool is disabled or empty.
   */
  setUseWebshareProxy(enabled: boolean) {
    this.useWebshareProxy = enabled
  }

  /**
   * The pool exit the last chat POST actually left through (undefined when
   * the request went out the direct exit). Failure reports anchor to this
   * instead of the pool's global last-selected marker, which concurrent
   * requests keep advancing.
   */
  getWebshareProxyUrlUsed(): string | undefined {
    return this.lastWebshareProxyUrl
  }

  private zOrigin(): string {
    const endpoint = (this.provider.apiEndpoint || '').trim()
    if (endpoint) {
      try {
        return new URL(endpoint).origin
      } catch {
        // fall through to env/fallback below
      }
    }
    return zaiStringEnv('CHAT2API_ZAI_API_BASE', ZAI_FALLBACK_ORIGIN)
  }

  private zApiRoot(): string {
    const endpoint = (this.provider.apiEndpoint || '').trim().replace(/\/+$/, '')
    if (endpoint) return endpoint
    return zaiStringEnv('CHAT2API_ZAI_API_ROOT', ZAI_FALLBACK_API_ROOT)
  }

  private zHost(): string {
    try {
      return new URL(this.zOrigin()).host
    } catch {
      return zaiStringEnv('CHAT2API_ZAI_HOST', ZAI_FALLBACK_HOST)
    }
  }

  private zProtocol(): string {
    try {
      return new URL(this.zOrigin()).protocol
    } catch {
      return 'https:'
    }
  }

  private zChatCompletionsUrl(): string {
    const chatPath = this.provider.chatPath || ZAI_FALLBACK_CHAT_PATH
    return `${this.zApiRoot()}${chatPath.startsWith('/') ? '' : '/'}${chatPath}`
  }

  private zUserAgent(): string {
    return (
      zaiHeader(this.provider, 'user-agent') ||
      zaiStringEnv('CHAT2API_ZAI_USER_AGENT', ZAI_FALLBACK_USER_AGENT)
    )
  }

  private zFeVersion(): string {
    return (
      zaiHeader(this.provider, 'x-fe-version') ||
      zaiStringEnv('CHAT2API_ZAI_FE_VERSION', ZAI_FALLBACK_FE_VERSION)
    )
  }

  private zLanguage(): string {
    return (
      zaiHeader(this.provider, 'accept-language') ||
      zaiStringEnv('CHAT2API_ZAI_LANGUAGE', ZAI_FALLBACK_LANGUAGE)
    )
  }

  private zLanguages(): string {
    const language = this.zLanguage()
    const fallback = language.includes('-') ? `${language},${language.split('-')[0]}` : language
    return zaiStringEnv('CHAT2API_ZAI_LANGUAGES', fallback)
  }

  private zBaseHeaders(): Record<string, string> {
    const configured = this.provider.headers || {}
    const headers: Record<string, string> =
      Object.keys(configured).length > 0
        ? { ...configured }
        : {
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'Accept-Language': this.zLanguage(),
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-Region': 'domestic',
          }
    if (!headers.Origin && !headers.origin) headers.Origin = this.zOrigin()
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = this.zUserAgent()
    return headers
  }
  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.jwt || ''
  }

  private getCaptchaVerifyParam(): string | undefined {
    // Always read fresh credentials from store to pick up captcha updates
    try {
      const freshAccount = storeManager.getAccountById(this.account.id, true)
      if (freshAccount?.credentials) {
        return freshAccount.credentials.captcha_verify_param || freshAccount.credentials.captchaVerifyParam || undefined
      }
    } catch (e) {
      // Fallback to cached credentials
    }
    const credentials = this.account.credentials
    return credentials.captcha_verify_param || credentials.captchaVerifyParam || undefined
  }

  private decodeJwtPayload(token: string): Record<string, any> | null {
    try {
      const parts = token.split('.')
      if (parts.length < 2) return null
      let payload = parts[1]
      const padding = payload.length % 4
      if (padding > 0) {
        payload += '='.repeat(4 - padding)
      }
      payload = payload.replace(/-/g, '+').replace(/_/g, '/')
      return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    } catch {
      return null
    }
  }

  private isTokenExpired(token: string): boolean {
    const payload = this.decodeJwtPayload(token)
    if (!payload || !payload.exp) return false
    return Date.now() >= payload.exp * 1000
  }

  private getTokenRemainingMs(token: string): number | null {
    const payload = this.decodeJwtPayload(token)
    if (!payload || !payload.exp) return null
    return payload.exp * 1000 - Date.now()
  }

  private async ensureToken(): Promise<string> {
    const token = this.getToken()
    if (!token) {
      throw new Error('Z.ai token not configured, please add token in account settings')
    }

    if (this.isTokenExpired(token)) {
      console.log('[Z.ai] Token expired, attempting auto-refresh...')
      const refreshed = await this.attemptTokenRefresh()
      if (refreshed) return refreshed
      throw new Error('Z.ai token has expired. Please re-login via the app to refresh your token.')
    }

    const remainingMs = this.getTokenRemainingMs(token)
    if (remainingMs !== null && remainingMs < TOKEN_EXPIRY_WARNING_MS) {
      console.log(`[Z.ai] Token expiring soon (${Math.round(remainingMs / 1000)}s remaining)`)
    }

    return token
  }

  private async attemptTokenRefresh(): Promise<string | null> {
    try {
      const { inAppLoginManager } = await import('../../oauth/inAppLogin')
      const result = await inAppLoginManager.startLogin({
        providerId: this.account.providerId || 'zai',
        providerType: 'zai',
        timeout: 120000,
      })
      if (result.success && result.credentials?.token) {
        const newToken = result.credentials.token
        storeManager.updateAccount(this.account.id, {
          credentials: { ...this.account.credentials, token: newToken },
        })
        console.log('[Z.ai] Token refreshed successfully via in-app login')
        return newToken
      }
      console.log('[Z.ai] In-app login did not return a valid token:', result.error)
    } catch (error) {
      console.log('[Z.ai] Auto-refresh failed (likely running in Docker/headless mode):', error instanceof Error ? error.message : error)
    }
    return null
  }

  private extractLastUserMessage(messages: ZaiMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content
        if (typeof content === 'string') {
          return content
        }
        if (Array.isArray(content)) {
          const textParts: string[] = []
          for (const part of content) {
            if (typeof part === 'object' && part !== null && part.type === 'text' && part.text) {
              textParts.push(part.text)
            }
          }
          if (textParts.length > 0) {
            return textParts.join('\n')
          }
        }
        return ''
      }
    }
    return ''
  }

  private extractUserIDFromToken(token: string): string {
    try {
      const parts = token.split('.')
      if (parts.length < 2) {
        return 'guest'
      }
      let payload = parts[1]
      const padding = payload.length % 4
      if (padding > 0) {
        payload += '='.repeat(4 - padding)
      }
      payload = payload.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(payload, 'base64').toString('utf8')
      const data = JSON.parse(decoded)
      return data.id || data.user_id || data.uid || data.sub || 'guest'
    } catch {
      return 'guest'
    }
  }

  private generateSignature(messageText: string, requestId: string, timestampMs: number, userId: string): string {
    const secret = ZAI_SIGNATURE_SECRET
    const r = timestampMs
    const i = String(timestampMs)
    const e = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`
    
    // a = message text UTF-8 bytes
    const a = Buffer.from(messageText, 'utf-8')
    // w = base64 encode of message text
    const w = a.toString('base64')
    // c = canonical string: metadata | base64_message | timestamp_string
    const canonicalString = `${e}|${w}|${i}`

    // E = window index (5 minute window)
    const windowIndex = Math.floor(r / ZAI_SIGNATURE_WINDOW_MS)
    
    // Layer1: A = HMAC(secret, window_index) -> hex string
    const derivedKey = crypto.createHmac('sha256', secret).update(String(windowIndex)).digest()
    
    // Layer2: k = HMAC(A_hex, canonical_string) -> hex string
    const signature = crypto.createHmac('sha256', derivedKey).update(canonicalString).digest('hex')

    return signature
  }

  async createChat(model: string = 'glm-5', firstMessageContent: string = ''): Promise<{ chatId: string; messageId: string }> {
    const token = await this.ensureToken()
    const timestamp = Math.floor(Date.now() / 1000)
    const messageId = uuid()
    
    console.log('[Z.ai] Creating chat with model:', model)
    
    const requestBody = {
      bot_id: '',
      chat: {
        id: '',
        title: 'New Chat',
        models: [model],
        params: {},
        history: {
          messages: firstMessageContent ? {
            [messageId]: {
              id: messageId,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: firstMessageContent,
              timestamp,
              models: [model],
            },
          } : {},
          currentId: firstMessageContent ? messageId : '',
        },
        tags: [],
        flags: [],
        features: [
          {
            type: 'tool_selector',
            server: 'tool_selector_h',
            status: 'hidden',
          },
        ],
        mcp_servers: [],
        enable_thinking: true,
        auto_web_search: false,
        reasoning_effort: 'max',
        message_version: 2,
        extra: {},
        timestamp: Date.now(),
        type: 'default',
      },
    }
    
    const makeRequest = async (tok: string) => axios.post(
      `${this.zApiRoot()}/v1/chats/new`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
          ...this.zBaseHeaders(),
          'Cookie': `token=${tok}`,
          Referer: `${this.zOrigin()}/`,
        },
        timeout: ZAI_CONTROL_TIMEOUT_MS,
        validateStatus: () => true,
      }
    )

    let response = await makeRequest(token)

    if ((response.status === 401 || response.status === 403)) {
      console.log(`[Z.ai] createChat auth error (${response.status}), attempting token refresh...`)
      const newToken = await this.attemptTokenRefresh()
      if (newToken) {
        this.token = newToken
        response = await makeRequest(newToken)
      }
    }

    if (response.status !== 200 && response.status !== 201) {
      console.error('[Z.ai] Create chat response:', response.status, response.data)
      throw new Error(`Failed to create chat: HTTP ${response.status}`)
    }

    console.log('[Z.ai] Chat created:', response.data.id)
    return { chatId: response.data.id, messageId }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      
      const response = await axios.delete(
        `${this.zApiRoot()}/v1/chats/${chatId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...this.zBaseHeaders(),
            Referer: `${this.zOrigin()}/`,
          },
          timeout: ZAI_CONTROL_TIMEOUT_MS,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Chat deleted:', chatId, 'Status:', response.status)
      return response.status === 200 || response.status === 204
    } catch (error) {
      console.error('[Z.ai] Failed to delete chat:', error)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      
      console.log('[Z.ai] Deleting all chats...')
      
      const response = await axios.delete(
        `${this.zApiRoot()}/v1/chats/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...this.zBaseHeaders(),
            Referer: `${this.zOrigin()}/`,
          },
          timeout: ZAI_DELETE_ALL_TIMEOUT_MS,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Delete all chats response:', response.status, response.data)
      
      if (response.status === 200 && response.data === true) {
        console.log('[Z.ai] All chats deleted successfully')
        return true
      }
      
      console.warn('[Z.ai] Delete all chats failed:', response.status, response.data)
      return false
    } catch (error) {
      console.error('[Z.ai] Failed to delete all chats:', error)
      return false
    }
  }

  private mapZaiModel(model: string): string {
    // Z.ai API requires specific model name casing:
    // - GLM-5.1 and GLM-5-Turbo keep uppercase
    // - GLM-5V-Turbo uses lowercase "v" in the request model id
    // - GLM-5 and GLM-4.7 use lowercase request model ids
    // Use provider-configured model mappings (from builtin/zai.ts) instead of hardcoded map.
    // Supports case-insensitive lookup so both GLM-5.3-Flash and glm-5.3-flash resolve correctly.
    const lowerModel = model.toLowerCase()
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    return model
  }

  private zaiVariables(): Record<string, string> {
    return {
      '{{USER_NAME}}': 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
      '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
      '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
      '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
      '{{CURRENT_TIMEZONE}}': zaiTimezone(),
      '{{USER_LANGUAGE}}': this.zLanguage(),
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; chatId: string; requestId: string }> {
    const token = await this.ensureToken()
    const userId = this.extractUserIDFromToken(token)

    console.log('[Z.ai] chatCompletion called with request.model:', request.model)

    const mappedModel = this.mapZaiModel(request.model)

    console.log('[Z.ai] Original model:', request.model, '-> Mapped model:', mappedModel)
    
    // Extract system message and merge with user message
    let systemContent = ''
    let processedMessages = []
    const toolProfile = getProviderToolProfile('zai')
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '')
      } else {
        processedMessages.push(normalizeZaiToolMessage(msg, toolProfile))
      }
    }
    
    // If system prompt exists, prepend it to the first user message
    if (systemContent && processedMessages.length > 0) {
      const firstUserIdx = processedMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const firstUserMsg = processedMessages[firstUserIdx]
        const originalContent = typeof firstUserMsg.content === 'string' 
          ? firstUserMsg.content 
          : (Array.isArray(firstUserMsg.content) 
              ? firstUserMsg.content.find((p: any) => p.type === 'text')?.text || '' 
              : '')
        
        processedMessages[firstUserIdx] = {
          ...firstUserMsg,
          content: `${systemContent}\n\nUser: ${originalContent}`
        }
      }
    }
    
    // Process file attachments from messages
    const fileUploader = new ZaiFileUploader(token, this.zApiRoot(), this.zBaseHeaders())
    const uploadedFileRefs: any[] = []
    const pendingUploadedFiles: ZaiUploadedFile[] = []
    for (let msgIdx = 0; msgIdx < processedMessages.length; msgIdx++) {
      const msg = processedMessages[msgIdx]
      if (msg.role !== 'user') continue
      const fileParts = collectFileParts(msg.content)
      if (fileParts.length === 0) continue
      // Extract text content from this message
      const textContent = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
            ? msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('')
            : '')
      // Upload each file and create references
      for (const part of fileParts) {
        try {
          const normalizedFile = await extractFileFromContent(part)
          if (!normalizedFile) continue
          const uploadedFile = await fileUploader.uploadFile(normalizedFile)
          pendingUploadedFiles.push(uploadedFile)
          console.log('[Z.ai] File uploaded:', uploadedFile.filename)
        } catch (err) {
          console.error('[Z.ai] Failed to upload file:', err)
        }
      }
      // Strip file/image parts from message content, keep only text
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length === 0 && textContent) {
          processedMessages[msgIdx] = { ...msg, content: textContent }
        } else if (textParts.length > 0) {
          processedMessages[msgIdx] = { ...msg, content: textParts }
        } else {
          processedMessages[msgIdx] = { ...msg, content: textContent || '' }
        }
      }
    }

    const signaturePrompt = this.extractLastUserMessage(processedMessages)
    // z.ai upstream builds model context from the seeded chat history, not the
    // completions messages array: seed multi-message requests with the full
    // flattened transcript so tool results and prior turns reach the model.
    const historySeed = processedMessages.length > 1
      ? renderZaiTranscript(processedMessages)
      : signaturePrompt
    if (processedMessages.length > 1) {
      console.log('[Z.ai] Seeding new chat with flattened history messages:', processedMessages.length)
    }
    
    // Always create a new chat (single-turn mode only)
    const chatResult = await this.createChat(mappedModel, historySeed)
    const chatId = chatResult.chatId
    const messageId = chatResult.messageId

    // References need the fresh user-message id, so bind uploads after chat creation.
    for (const uploadedFile of pendingUploadedFiles) {
      uploadedFileRefs.push(fileUploader.createFileReference(uploadedFile, messageId))
      console.log('[Z.ai] File referenced:', uploadedFile.filename)
    }
    const parentMessageId = null
    console.log('[Z.ai] Created new chat:', chatId)
    
    const requestId = uuid()
    const timestamp = Date.now()
    const signature = this.generateSignature(signaturePrompt, requestId, timestamp, userId)

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    const effortLevel = zaiReasoningEffortLevel(request.reasoning_effort)
    if (effortLevel) console.log('[Z.ai] Thinking depth level:', effortLevel)
    let enableThinking = request.reasoning_effort === false ? false : true
    let enableWebSearch = !!request.web_search
    if (request.web_search === true) console.log('[Z.ai] Web search enabled (from request param)')
    if (request.deep_research === true) {
      enableWebSearch = true
      if (request.reasoning_effort !== false) enableThinking = true
      console.log('[Z.ai] Advanced search (multi-round research) enabled via deep_research')
    }
    
    // Auto-enable based on model name (if not explicitly set)
    if (!enableThinking && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Z.ai] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Z.ai] Web search enabled (from model name)')
    }

    // Z.ai API uses auto_web_search for web search feature
    // web_search should always be false, use auto_web_search instead
    const features = {
      image_generation: false,
      web_search: false,
      auto_web_search: enableWebSearch,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: enableThinking,
      ...(enableThinking ? { reasoning_effort: effortLevel ?? 'max', ...(request.thinking_budget ? { thinking_budget: request.thinking_budget } : {}) } : {}),
    }

    // Qwen-style context offload: archive oversized inline history as an
    // uploaded transcript document so long sessions survive the byte target.
    if (zaiTranscriptUploadEnabled()) {
      const maxBytes = zaiRequestMaxBytesFromEnv()
      const inlineBytes = Buffer.byteLength(JSON.stringify(processedMessages), 'utf8')
      if (maxBytes > 0 && inlineBytes > maxBytes) {
        const transcript = renderZaiTranscript(processedMessages)
        const tailExcerpt = zaiTranscriptTail(transcript, ZAI_TRANSCRIPT_TAIL_BYTES)
        try {
          const transcriptBuffer = Buffer.from(transcript, 'utf8')
          const uploadedTranscript = await fileUploader.uploadFile({
            data: transcriptBuffer,
            sizeBytes: transcriptBuffer.byteLength,
            filename: `context-${requestId.slice(0, 8)}.txt`,
            mimeType: 'text/plain',
          })
          uploadedFileRefs.push(fileUploader.createFileReference(uploadedTranscript, messageId))
          processedMessages = [
            {
              role: 'user',
              content: `The complete conversation context is attached as ${uploadedTranscript.filename}. A tail excerpt follows:
${tailExcerpt}`,
            },
          ]
          console.log('[Z.ai] Context offloaded to transcript document:', uploadedTranscript.filename, 'inlineBytes:', inlineBytes)
        } catch (err) {
          console.error('[Z.ai] Transcript offload failed, keeping inline context:', err)
        }
      }
    }

    const requestBody: Record<string, any> = {
      stream: request.stream !== false,
      model: mappedModel,
      messages: processedMessages,
      signature_prompt: signaturePrompt,
      params: {},
      extra: {},
      features,
      variables: this.zaiVariables(),
      chat_id: chatId,
      id: requestId,
      current_user_message_id: messageId,
      current_user_message_parent_id: parentMessageId,
      background_tasks: {
        title_generation: true,
        tags_generation: true,
      },
    }

    const captchaVerifyParam = this.getCaptchaVerifyParam()
    if (captchaVerifyParam) {
      requestBody.captcha_verify_param = captchaVerifyParam
    }

    // Add uploaded file references to request body
    if (uploadedFileRefs.length > 0) {
      requestBody.files = uploadedFileRefs
      console.log('[Z.ai] Attached', uploadedFileRefs.length, 'file(s) to request')
    }

    console.log('[Z.ai] Sending chat request...')
    console.log('[Z.ai] Model:', request.model)
    console.log('[Z.ai] ChatId:', chatId)
    console.log('[Z.ai] MessageId (current_user_message_id):', messageId)
    console.log('[Z.ai] ParentMessageId:', parentMessageId || '(none)')

    const response = await this.sendRequestWithRetry(requestBody, token, chatId, signature, timestamp, requestId, userId)

    // Peek at stream to detect captcha errors before returning
    if (response.status === 200 && response.data && typeof response.data.on === 'function' && !this.captchaRetryAttempted) {
      try {
        const firstChunk = await ZaiAdapter.peekStreamFirstChunk(response.data, 8000)

        if (firstChunk.length > 0) {
          const chunkText = firstChunk.toString('utf8')
          if (chunkText.includes('FRONTEND_CAPTCHA_REQUIRED')) {
            console.log('[Z.ai] Captcha error detected, solving and retrying with fresh context...')
            // Destroy the failed stream
            try { response.data.destroy() } catch {}
            const { solveCaptchaAndUpdateAccount } = await import('./zai-captcha-solver')
            const solved = await solveCaptchaAndUpdateAccount(this.account.id, token)
            if (solved) {
              this.captchaRetryAttempted = true
              // Redo entire chatCompletion with fresh chat, signature, timestamp, requestId
              console.log('[Z.ai] Retrying chatCompletion with fresh context after captcha solve...')
              return this.chatCompletion(request)
            }
            console.log('[Z.ai] Captcha solve failed, returning original response')
          }

          // No captcha error - reconstruct stream with peeked chunk prepended
          const { PassThrough } = await import('stream')
          const reconstructed = new PassThrough()
          reconstructed.write(firstChunk)
          response.data.pipe(reconstructed)
          response.data = reconstructed as any
        }
      } catch (peekErr) {
        console.error('[Z.ai] Stream peek error:', peekErr)
      }
    }

    return { response, chatId, requestId }
  }

  /**
   * Managed workflow continuation tier 1: append a follow-up user turn to an
   * EXISTING z.ai chat instead of seeding a new one. `current_user_message_id`
   * is a fresh id for the follow-up and `current_user_message_parent_id`
   * anchors it on the assistant message the chat just produced, so the
   * upstream keeps its own session context (thinking state, seeded transcript,
   * and the dangling assistant branch). Mirrors the Qwen same-chat
   * continuation contract.
   */
  async continueChat(request: ChatCompletionRequest & { chatId: string; parentMessageId: string }): Promise<{ response: AxiosResponse; chatId: string; requestId: string }> {
    if (!request.chatId || !request.parentMessageId) {
      throw new Error('[Z.ai] continueChat requires chatId and parentMessageId')
    }
    const token = await this.ensureToken()
    const userId = this.extractUserIDFromToken(token)

    const mappedModel = this.mapZaiModel(request.model)
    const toolProfile = getProviderToolProfile('zai')
    const processedMessages = request.messages.map((msg) => normalizeZaiToolMessage(msg, toolProfile))

    const nudgeText = this.extractLastUserMessage(processedMessages)
    const requestId = uuid()
    const userMessageId = uuid()
    const timestamp = Date.now()
    const signature = this.generateSignature(nudgeText, requestId, timestamp, userId)

    const effortLevel = zaiReasoningEffortLevel(request.reasoning_effort)
    const enableThinking = request.reasoning_effort !== false
    const requestBody: Record<string, any> = {
      stream: true,
      model: mappedModel,
      messages: processedMessages,
      signature_prompt: nudgeText,
      params: {},
      extra: {},
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: !!request.web_search,
        preview_mode: true,
        flags: [],
        vlm_tools_enable: false,
        vlm_web_search_enable: false,
        vlm_website_mode: false,
        enable_thinking: enableThinking,
        ...(enableThinking ? { reasoning_effort: effortLevel ?? 'max', ...(request.thinking_budget ? { thinking_budget: request.thinking_budget } : {}) } : {}),
      },
      variables: this.zaiVariables(),
      chat_id: request.chatId,
      id: requestId,
      current_user_message_id: userMessageId,
      current_user_message_parent_id: request.parentMessageId,
      // A recovery turn must not churn chat titles/tags on the account.
      background_tasks: {
        title_generation: false,
        tags_generation: false,
      },
    }

    const captchaVerifyParam = this.getCaptchaVerifyParam()
    if (captchaVerifyParam) {
      requestBody.captcha_verify_param = captchaVerifyParam
    }

    console.log('[Z.ai] Sending continuation request...')
    console.log('[Z.ai] Continuation model:', mappedModel)
    console.log('[Z.ai] Continuation chatId:', request.chatId)
    console.log('[Z.ai] Continuation parentMessageId:', request.parentMessageId)

    let response = await this.sendRequestWithRetry(requestBody, token, request.chatId, signature, timestamp, requestId, userId)

    // Captcha gate parity with chatCompletion: peek the first chunk so a
    // FRONTEND_CAPTCHA_REQUIRED failure is solved and retried in place
    // instead of aborting the replacement branch mid-stream.
    if (response.status === 200 && response.data && typeof response.data.on === 'function') {
      try {
        const firstChunk = await ZaiAdapter.peekStreamFirstChunk(response.data, 8000)
        if (firstChunk.length > 0) {
          if (firstChunk.toString('utf8').includes('FRONTEND_CAPTCHA_REQUIRED')) {
            console.log('[Z.ai] Continuation captcha error detected, solving and retrying...')
            try { response.data.destroy() } catch {}
            const { solveCaptchaAndUpdateAccount } = await import('./zai-captcha-solver')
            const solved = await solveCaptchaAndUpdateAccount(this.account.id, token)
            if (solved) {
              const freshParam = this.getCaptchaVerifyParam()
              if (freshParam) requestBody.captcha_verify_param = freshParam
              const retryRequestId = uuid()
              const retryTimestamp = Date.now()
              const retrySignature = this.generateSignature(nudgeText, retryRequestId, retryTimestamp, userId)
              response = await this.sendRequestWithRetry(requestBody, token, request.chatId, retrySignature, retryTimestamp, retryRequestId, userId)
              return { response, chatId: request.chatId, requestId: retryRequestId }
            }
            console.log('[Z.ai] Continuation captcha solve failed, returning original response')
          }
          // Reconstruct the stream with the peeked chunk prepended so no
          // upstream byte is lost to the peek.
          const reconstructed = new PassThrough()
          reconstructed.write(firstChunk)
          response.data.pipe(reconstructed)
          response.data = reconstructed as any
        }
      } catch (peekErr) {
        console.error('[Z.ai] Continuation stream peek error:', peekErr)
      }
    }

    return { response, chatId: request.chatId, requestId }
  }

  /**
   * Resolve the assistant message id to anchor a same-chat continuation.
   * The v2 SSE stream never returns the assistant message id (observed:
   * done frames carry only {phase:'done',done:true}), so the id must come
   * from the chat tree. Mirrors how the z.ai web client addresses follow-up
   * turns inside an existing conversation.
   */
  async getLastAssistantMessageId(chatId: string): Promise<string> {
    try {
      const token = await this.ensureToken()
      const response = await axios.get(
        `${this.zApiRoot()}/v1/chats/${chatId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...this.zBaseHeaders(),
            'Cookie': `token=${token}`,
            Referer: `${this.zOrigin()}/c/${chatId}`,
          },
          timeout: ZAI_CONTROL_TIMEOUT_MS,
          validateStatus: () => true,
        },
      )
      if (response.status !== 200) {
        console.warn('[Z.ai] Fetch chat for assistant id failed:', response.status)
        return ''
      }
      const chat = response.data?.data?.chat ?? response.data?.chat
      const history = chat?.history
      const messages = history?.messages
      if (!messages || typeof messages !== 'object') {
        if (zaiDebugStreamFromEnv()) {
          console.log('[Z.ai] DEBUG chat payload shape:', JSON.stringify(response.data).slice(0, 800))
        }
        console.warn('[Z.ai] Chat history missing for assistant id lookup:', chatId)
        return ''
      }
      const currentId: string | undefined = history.currentId
      if (currentId && messages[currentId]?.role === 'assistant') {
        return currentId
      }
      let latestId = ''
      let latestTimestamp = -1
      for (const [id, message] of Object.entries(messages as Record<string, { role?: string; timestamp?: number }>)) {
        if (message?.role !== 'assistant') continue
        const ts = typeof message.timestamp === 'number' ? message.timestamp : -1
        if (ts >= latestTimestamp) {
          latestTimestamp = ts
          latestId = id
        }
      }
      return latestId
    } catch (error) {
      console.warn('[Z.ai] Assistant id lookup failed:', error instanceof Error ? error.message : error)
      return ''
    }
  }

  /**
   * Read the first upstream chunk without losing it: callers decide whether
   * the chunk signals a captcha failure or gets prepended back onto the
   * stream. Resolves an empty buffer when nothing arrives within the window.
   */
  static peekStreamFirstChunk(data: any, timeoutMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve) => {
      let resolved = false
      const onData = (chunk: Buffer) => {
        if (!resolved) { resolved = true; data.removeListener('data', onData); resolve(chunk) }
      }
      data.on('data', onData)
      setTimeout(() => { if (!resolved) { resolved = true; resolve(Buffer.alloc(0)) } }, timeoutMs)
    })
  }

  private async sendRequestWithRetry(
    requestBody: Record<string, any>,
    token: string,
    chatId: string,
    signature: string,
    timestamp: number,
    requestId: string,
    userId: string,
    isRetry: boolean = false,
  ): Promise<AxiosResponse> {
    const screenWidth = zaiStringEnv('CHAT2API_ZAI_SCREEN_WIDTH', '1512')
    const screenHeight = zaiStringEnv('CHAT2API_ZAI_SCREEN_HEIGHT', '982')
    const viewportWidth = zaiStringEnv('CHAT2API_ZAI_VIEWPORT_WIDTH', '923')
    const viewportHeight = zaiStringEnv('CHAT2API_ZAI_VIEWPORT_HEIGHT', '945')
    const queryParams = new URLSearchParams({
      timestamp: String(timestamp),
      requestId,
      user_id: userId,
      version: '0.0.1',
      platform: 'web',
      token,
      user_agent: this.zUserAgent(),
      language: this.zLanguage(),
      languages: this.zLanguages(),
      timezone: zaiTimezone(),
      cookie_enabled: 'true',
      screen_width: screenWidth,
      screen_height: screenHeight,
      screen_resolution: `${screenWidth}x${screenHeight}`,
      viewport_height: viewportHeight,
      viewport_width: viewportWidth,
      viewport_size: `${viewportWidth}x${viewportHeight}`,
      color_depth: zaiStringEnv('CHAT2API_ZAI_COLOR_DEPTH', '30'),
      pixel_ratio: zaiStringEnv('CHAT2API_ZAI_PIXEL_RATIO', '2'),
      current_url: `${this.zOrigin()}/c/${chatId}`,
      pathname: `/c/${chatId}`,
      search: '',
      hash: '',
      host: this.zHost(),
      hostname: this.zHost(),
      protocol: this.zProtocol(),
      referrer: '',
      title: zaiStringEnv('CHAT2API_ZAI_PAGE_TITLE', ZAI_FALLBACK_PAGE_TITLE),
      timezone_offset: String(zaiTimezoneOffsetMinutes()),
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: 'false',
      is_touch: 'false',
      max_touch_points: '0',
      browser_name: zaiStringEnv('CHAT2API_ZAI_BROWSER_NAME', 'Chrome'),
      os_name: zaiStringEnv('CHAT2API_ZAI_OS_NAME', 'Mac OS'),
      signature_timestamp: String(timestamp),
    })

    // One atomic pool checkout per attempt: the agent and the exit it leaves
    // through are selected together, so failure reports (here and in the
    // forwarder) anchor to the exit that actually served the request. The
    // previous shape evaluated getWebshareProxyAgent() twice per request,
    // advancing round-robin twice and risking a different exit per call.
    const webshareCheckout = this.useWebshareProxy ? checkoutWebshareProxyAgent() : undefined
    this.lastWebshareProxyUrl = webshareCheckout?.proxyUrl

    const response = await axios.post(
      `${this.zChatCompletionsUrl()}?${queryParams.toString()}`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...this.zBaseHeaders(),
          'X-Signature': signature,
          'X-FE-Version': this.zFeVersion(),
          'Cookie': `token=${token}`,
          Referer: `${this.zOrigin()}/c/${chatId}`,
          Priority: 'u=1, i',
          // SSE must arrive uncompressed so the stream parser can read every chunk.
          'Accept-Encoding': 'identity',
        },
        responseType: 'stream',
        timeout: ZAI_CHAT_TIMEOUT_MS,
        validateStatus: () => true,
        // Exit-IP WAF verdicts (zai_waf_405_block) are lifted by routing the
        // recovery attempt through the configured webshare pool, mirroring
        // the qwen capacity_limit fast path.
        ...(webshareCheckout ? { httpsAgent: webshareCheckout.agent } : {}),
      }
    )

    console.log('[Z.ai] Response status:', response.status)



    if ((response.status === 401 || response.status === 403) && !isRetry) {
      console.log(`[Z.ai] Auth error (${response.status}), attempting token refresh...`)
      const newToken = await this.attemptTokenRefresh()
      if (newToken) {
        this.token = newToken
        return this.sendRequestWithRetry(requestBody, newToken, chatId, signature, timestamp, requestId, userId, true)
      }
      console.log('[Z.ai] Token refresh failed, returning auth error')
    }

    if (response.status !== 200) {
      console.log('[Z.ai] Request body:', JSON.stringify(requestBody, null, 2))
      console.log('[Z.ai] Signature:', signature)
      console.log('[Z.ai] Timestamp:', timestamp)
      console.log('[Z.ai] RequestId:', requestId)
      console.log('[Z.ai] UserId:', userId)
      if (response.data && typeof response.data.on === 'function') {
        const chunks: Buffer[] = []
        response.data.on('data', (chunk: Buffer) => chunks.push(chunk))
        await new Promise<void>((resolve) => {
          response.data.on('end', () => resolve())
          response.data.on('error', () => resolve())
        })
        const errorBody = Buffer.concat(chunks).toString('utf8')
        console.log('[Z.ai] Error response body:', errorBody)
        Object.assign(response, { zaiErrorBody: errorBody })
      } else if (response.data) {
        console.log('[Z.ai] Error response data:', JSON.stringify(response.data, null, 2))
        Object.assign(response, { zaiErrorBody: JSON.stringify(response.data) })
      }
    }

    return response
  }

  static isZaiProvider(provider: Provider): boolean {
    return provider.id === 'zai' || provider.apiEndpoint.includes('z.ai') || provider.apiEndpoint.includes('chat.z.ai')
  }
}

const MANAGED_SHORT_ANSWER_CODE_POINTS = 300

/**
 * True when the conversation's previous assistant message is itself short
 * prose (same narration cap). Together with the caller's checks — current
 * answer short, marker-less, tool-call-less — this identifies a stall loop:
 * consecutive short prose turns over declared tools with no tool activity in
 * between. The previous text is forwarder-extracted from client history, so
 * the rule carries no wording patterns.
 */
function isConsecutiveShortProse(trailingAssistantText: string | undefined): boolean {
  if (!trailingAssistantText) return false
  return [...trailingAssistantText.trim()].length <= MANAGED_SHORT_ANSWER_CODE_POINTS
}

/**
 * True when the answer's trailing fenced code block parses as a JSON object
 * whose top-level keys are ALL declared tool parameter names. The model
 * sometimes writes the NEXT tool call's argument object as a fenced JSON
 * example instead of the taught wire format (observed live 2026-09-11,
 * GLM-5.3-Flash via codex: a unified_exec {"cmd", "yield_time_ms"} block
 * delivered as prose; the turn completed and the action was lost). Such a
 * block is an un-executed tool attempt, not documentation. Guards against
 * false positives on legitimately documented examples: the fence must end the
 * answer, the prose before it is capped like progress-intent prose, and the
 * key match is derived from the declared schemas (never hardcoded).
 */
function hasTrailingFencedToolArgumentJson(trimmed: string, plan: ToolCallingPlan): boolean {
  const closer = trimmed.lastIndexOf('```')
  if (closer === -1 || closer + 3 !== trimmed.length) return false
  const opener = trimmed.lastIndexOf('```', closer - 1)
  if (opener === -1) return false
  if ([...trimmed.slice(0, opener)].length > MANAGED_SHORT_ANSWER_CODE_POINTS) return false
  const firstLineEnd = trimmed.indexOf('\n', opener)
  if (firstLineEnd === -1 || firstLineEnd > closer) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(firstLineEnd + 1, closer))
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.length === 0) return false
  const declaredParameterNames = new Set<string>()
  for (const tool of plan.tools ?? []) {
    const properties = tool.parameters?.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const name of Object.keys(properties)) declaredParameterNames.add(name)
    }
  }
  if (declaredParameterNames.size === 0) return false
  return keys.every((key) => declaredParameterNames.has(key))
}

export interface ZaiManagedAnswerVerdict {
  /** True when the turn should be recovered with a managed workflow continuation. */
  continuation: boolean
  /** The branch read as final but omitted the required completion marker. */
  completionProofMissing: boolean
  /** The continuation prompt must demand a concrete tool call instead of offering the final-answer alternative. */
  requireManagedToolCall: boolean
  /** Classification label for logs. Empty when the answer is delivered normally. */
  reason: string
}

function zaiManagedAnswerIdle(reason: string): ZaiManagedAnswerVerdict {
  return { continuation: false, completionProofMissing: false, requireManagedToolCall: false, reason }
}

/**
 * Ported from the Qwen managed-tool governance: classifies marker-less,
 * tool-call-less answers that would silently stall an agentic workflow so
 * the caller can trigger a managed workflow continuation.
 *
 * Deliberate divergence from the Qwen classifier: a long marker-less final
 * answer over a live workflow is NOT a continuation candidate here. The z.ai
 * stream bridge has no content-replacement plumbing, so re-prompting a
 * substantive answer would append a near-duplicate of text already delivered
 * to the client; that family is reported via `reason` but delivered as-is.
 */
function classifyZaiManagedAnswer(
  content: string,
  plan: ToolCallingPlan | undefined,
  options: { isRecoveryBranch?: boolean; trailingAssistantText?: string } = {},
): ZaiManagedAnswerVerdict {
  if (!plan?.shouldParseResponse) return zaiManagedAnswerIdle('parse_disabled')
  let parsed: { toolCalls?: unknown[]; rawMatches?: unknown[]; malformedReason?: string }
  try {
    parsed = getToolProtocol(plan.protocol).parse(content, {
      tools: plan.tools,
      protocol: plan.protocol,
      allowPartial: true,
    })
  } catch {
    parsed = { toolCalls: [], rawMatches: [], malformedReason: 'classification_parse_error' }
  }
  if (parsed.toolCalls && parsed.toolCalls.length > 0) return zaiManagedAnswerIdle('tool_call_present')
  if (hasManagedWorkflowCompletionMarker(content, plan)) return zaiManagedAnswerIdle('completion_marker_present')
  if (/<chat2api_workflow_complete(?:\/|>)[\s\S]*\S/.test(content)) {
    return {
      continuation: true,
      completionProofMissing: false,
      requireManagedToolCall: plan.hasLiveToolWorkflow === true,
      reason: 'completion_marker_followed_by_prose',
    }
  }
  const trimmed = content.trim()
  if (!trimmed) return zaiManagedAnswerIdle('empty_answer')
  if (plan.failedToolResultPending === true) return zaiManagedAnswerIdle('failed_tool_result_pending')
  // A protocol-shaped block that yielded no valid tool call is a REJECTED tool
  // attempt (undeclared name, schema-invalid args, truncated mid-call — none
  // set malformedReason). The stream parser drops such blocks silently, so the
  // client only ever saw the surrounding prose; delivering it ends the turn
  // with the action lost. Recover regardless of workflow state: observed live
  // 2026-09-11 (GLM-5.3-Flash first turn): the model emitted a managed_xml
  // call to an undeclared tool, the block was dropped, and the appended block
  // length also defeated the 300-codepoint progress-intent cap, so the
  // promise prose was delivered and the client turn stopped. Must precede the
  // progress-style checks — those cap on the WHOLE content, which the rejected
  // block itself inflates.
  if (hasRejectedToolCallBlock(parsed)) {
    console.info('[Z.ai] Rejected tool-call block without a valid call triggers continuation', JSON.stringify({
      invalidToolNames: parsed.invalidToolNames,
      malformedReason: parsed.malformedReason,
      blockCount: parsed.rawMatches.length,
    }))
    // A rejected block IS an attempted call — the recovery nudge must demand
    // the corrected wire-format call regardless of workflow state.
    return {
      continuation: true,
      completionProofMissing: false,
      requireManagedToolCall: true,
      reason: 'rejected_tool_call_block',
    }
  }
  // Structural, wording-independent recovery-branch rule: the model has
  // already been re-prompted once to produce a tool call or a proven final
  // answer, so any SHORT marker-less tool-call-less branch is workflow
  // narration by construction — no opener word-list is consulted (observed
  // live 2026-09-11: an attempt-1 branch escaped with a promise sentence the
  // opener list had never seen and the turn stalled a second time). Long
  // marker-less branches keep the live-workflow divergence: they are delivered
  // as-is because re-prompting would duplicate delivered text.
  if (options.isRecoveryBranch && [...trimmed].length <= MANAGED_SHORT_ANSWER_CODE_POINTS) {
    console.info('[Z.ai] Short marker-less answer over a recovery branch triggers continuation')
    return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'recovery_branch_markerless_answer' }
  }
  // Structural, wording-independent stall-loop rule: a short marker-less
  // answer that FOLLOWS another short marker-less assistant message (tools
  // declared, no tool calls anywhere in between — the classify order already
  // guarantees neither branch carries one) is the model re-narrating its plan
  // across turns instead of acting (observed live 2026-09-11: after a stall
  // the user re-prompted and the model answered with a paraphrase of its
  // earlier promise prose — character-bigram similarity measured only ~0.35,
  // so wording/similarity matching cannot cover this family; consecutive
  // short prose with declared tools is the invariant). The length constant is
  // the shared narration cap, not a new threshold.
  if (
    [...trimmed].length <= MANAGED_SHORT_ANSWER_CODE_POINTS
    && isConsecutiveShortProse(options.trailingAssistantText)
  ) {
    console.info('[Z.ai] Consecutive short prose answers over declared tools; triggers continuation')
    return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'consecutive_short_prose_answers' }
  }
  if (plan.hasLiveToolWorkflow) {
    if (isProgressStyleManagedAnswer(trimmed)) {
      console.info('[Z.ai] Progress-style answer over live workflow triggers continuation')
      return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'progress_style_answer_over_live_workflow' }
    }
    if ([...trimmed].length <= MANAGED_SHORT_ANSWER_CODE_POINTS) {
      console.info('[Z.ai] Short marker-less answer over live workflow triggers continuation')
      return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'short_markerless_answer_over_live_workflow' }
    }
  }
  if (isProgressStyleManagedAnswer(trimmed)) {
    console.info('[Z.ai] Progress-style answer without tool call triggers continuation')
    // The model announced an upcoming action, so the recovery nudge must
    // demand the concrete tool call (renderRecoveryPrompt); offering the
    // final-answer alternative just yields another promise sentence
    // (observed live 2026-09-11: an attempt-1 branch escaped with a novel
    // promise sentence and the turn stalled again).
    return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'progress_style_answer_without_tool_call' }
  }
  if (isToolDenialManagedAnswer(trimmed)) {
    console.info('[Z.ai] Capability-denial answer triggers continuation')
    return { continuation: true, completionProofMissing: false, requireManagedToolCall: false, reason: 'capability_denial_answer' }
  }
  // A short answer ending in a colon promises an enumeration, command, code
  // block, or tool call that never arrived. Structural and wording-independent
  // (observed live 2026-09-11 first turn: "…我用这个 UUID 搜文件名和内容：" was
  // delivered as the whole answer and the client turn stopped); must precede
  // the first-turn idle fall-throughs below. Deployment-tunable: set
  // CHAT2API_ZAI_COLON_PROMISE_CONTINUATION=off to disable the signal.
  if (zaiBooleanEnv('CHAT2API_ZAI_COLON_PROMISE_CONTINUATION', true) && isColonTerminatedShortAnswer(trimmed)) {
    console.info('[Z.ai] Colon-terminated short answer without tool call triggers continuation')
    // Promised action → the recovery nudge demands the concrete tool call.
    return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'colon_terminated_short_answer' }
  }
  // The model sometimes writes the next tool call's argument object as a
  // fenced JSON block instead of the taught wire format; the block is not
  // executed and the turn ends with the action lost. Schema-derived key match,
  // no hardcoded tool names (observed live 2026-09-11 first turn). Deployment-
  // tunable: set CHAT2API_ZAI_FENCED_TOOL_ARGS_CONTINUATION=off to disable.
  if (zaiBooleanEnv('CHAT2API_ZAI_FENCED_TOOL_ARGS_CONTINUATION', true) && hasTrailingFencedToolArgumentJson(trimmed, plan)) {
    console.info('[Z.ai] Trailing fenced JSON matching declared tool parameters triggers continuation')
    // The block IS an attempted call → the recovery nudge demands the real
    // wire-format call.
    return { continuation: true, completionProofMissing: false, requireManagedToolCall: true, reason: 'fenced_tool_argument_json' }
  }
  const midWorkflow = plan.workflowContinuation || plan.hasLiveToolWorkflow === true
  if (!midWorkflow) {
    // Rejected protocol blocks already returned as 'rejected_tool_call_block'
    // above; nothing reaches this branch with rawMatches left to inspect.
    if (plan.toolChoiceMode === 'auto') return zaiManagedAnswerIdle('first_turn_auto_answer')
    if (trimmed.length > 0) return zaiManagedAnswerIdle('first_turn_answer')
  }
  if (requiresManagedWorkflowCompletionMarker(plan) && !hasManagedWorkflowCompletionMarker(content, plan)) {
    if (plan.hasLiveToolWorkflow === true) {
      // See the class-level comment: substantive marker-less finals are
      // delivered as-is instead of risking a duplicated visible answer.
      return zaiManagedAnswerIdle('completion_marker_missing_live_workflow')
    }
    return { continuation: true, completionProofMissing: true, requireManagedToolCall: false, reason: 'completion_marker_missing_short_answer' }
  }
  return zaiManagedAnswerIdle('answer_delivered')
}
export { classifyZaiManagedAnswer }

/**
 * Recovery handle supplied by the forwarder: turns a classified dangling
 * answer into a fresh upstream generation, tier 1 being a same-chat
 * follow-up anchored on the assistant message and tier 2 a fresh-chat
 * replay of the transcript with the dangling branch + continuation prompt
 * appended. Both tiers return the raw upstream SSE response; the stream
 * handler splices the replacement branch into the client-visible stream.
 */
export interface ZaiWorkflowContinuationHandle {
  start(
    verdict: ZaiManagedAnswerVerdict,
    danglingContent: string,
    parentMessageId: string,
  ): Promise<{ response: AxiosResponse; chatId: string } | null>
  activeChatId(): string
}
export class ZaiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private content: string = ''
  private toolCallsSent: boolean = false
  private lastMessageId: string = ''
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private sentRole: boolean = false
  private sentThinkingRole: boolean = false
  private streamEnded: boolean = false
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }
  private accountId: string = ''
  private accountToken: string = ''
  private continuation?: ZaiWorkflowContinuationHandle
  private trailingAssistantText?: string

  constructor(model: string, onEnd?: (chatId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  setAccountInfo(accountId: string, accountToken: string) {
    this.accountId = accountId
    this.accountToken = accountToken
  }

  /**
   * Install the managed workflow continuation handle (forwarder-supplied).
   * When set, a classified dangling answer is recovered with a replacement
   * upstream branch instead of being delivered as a silent stall.
   */
  setContinuation(continuation: ZaiWorkflowContinuationHandle) {
    this.continuation = continuation
  }

  /**
   * Text of the conversation's previous assistant message (forwarder-extracted
   * from client history). Feeds the structural repeated-narration rule: a
   * short answer that substantially repeats it is plan narration, not action.
   */
  setTrailingAssistantText(text: string | undefined) {
    this.trailingAssistantText = text?.trim() || undefined
  }

  /** Latest upstream chat id, including any fresh-chat continuation tier. */
  getActiveChatId(): string {
    return this.continuation?.activeChatId() ?? this.chatId
  }

  getLastMessageId(): string {
    return this.lastMessageId
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd) {
        try {
          this.onEnd(this.chatId)
        } catch (e) {
          console.error('[Z.ai] onEnd callback error:', e)
        }
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[Z.ai] Starting stream handler...')

    // Client-visible stream state: once ended, nothing more may be written.
    let clientEnded = false
    // Per-branch state: a continuation replacement branch gets a fresh tool
    // parser and its own content window; `this.content` stays cumulative so
    // delivered prose and the replacement branch both reach the client in
    // order.
    let branchToolParser = this.toolStreamParser
    let branchContentStart = 0
    let branchFinished = false
    let continuationInFlight = false
    let continuationSeq = 0
    let idleTimer: NodeJS.Timeout | undefined

    const stopIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    const safeEnd = (data?: string) => {
      if (clientEnded) return
      clientEnded = true
      stopIdleTimer()
      if (data) {
        transStream.end(data)
      } else {
        transStream.end()
      }
    }

    const notifyEnd = () => {
      if (!this.onEnd) return
      try {
        this.onEnd(this.getActiveChatId())
      } catch (e) {
        console.error('[Z.ai] onEnd callback error:', e)
      }
    }

    const finishStream = (finishReason: string, usage?: any) => {
      if (clientEnded) return
      transStream.write(
        `data: ${JSON.stringify({
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: usage || { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      safeEnd('data: [DONE]\n\n')
      notifyEnd()
    }

    const writeVisibleNotice = (text: string) => {
      if (clientEnded) return
      transStream.write(
        `data: ${JSON.stringify({
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          created: this.created,
        })}\n\n`
      )
    }

    // Managed-workflow recovery exhausted with a dangling answer already on
    // the wire. A clean `finish_reason: stop` here makes agentic clients
    // record the dangling prose as the final assistant message and END THE
    // TURN — the silent-stall family from 2026-09-11 22:24, where captcha →
    // WAF 405 → webshare 402 burned every recovery tier and the promise
    // sentence was then delivered as a normal completion. Ending with an
    // explicit error chunk and NO finish_reason makes the Responses
    // translator emit `response.failed`, so codex discards the partial
    // answer and retries the request while upstream recovery (x5sec
    // harvest, WAF verdict cool-down) runs its course. Chat-wire clients get
    // the visible notice instead of a silently truncated answer.
    const failStreamAfterExhaustedRecovery = (reason: string) => {
      if (clientEnded) return
      console.error('[Z.ai] Managed workflow recovery exhausted; failing the client stream for a client-side retry', JSON.stringify({
        reason,
        contentLength: this.content.length,
      }))
      writeVisibleNotice('\n\n[Z.ai] Workflow recovery exhausted upstream; failing this turn so the request can be retried.')
      transStream.write(
        `data: ${JSON.stringify({
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          error: {
            code: 'zai_workflow_recovery_exhausted',
            message: `managed workflow recovery exhausted (dangling answer: ${reason}); retry the request`,
            param: null,
            type: 'upstream_error',
          },
        })}\n\n`
      )
      safeEnd('data: [DONE]\n\n')
      notifyEnd()
    }

    const attachUpstream = (upstreamStream: any) => {
      const branchParser = createParser({ onEvent: handleEvent })
      upstreamStream.on('data', (buffer: Buffer) => {
        if (clientEnded || continuationInFlight) return
        armIdleTimer()
        branchParser.feed(buffer.toString())
      })
      upstreamStream.once('error', (err: Error) => {
        console.error('[Z.ai] Stream error:', err)
        // A `done` event (or an in-flight continuation swap) owns the terminal.
        if (clientEnded || branchFinished || continuationInFlight) return
        branchFinished = true
        safeEnd('data: [DONE]\n\n')
      })
      upstreamStream.once('close', () => {
        console.log('[Z.ai] Stream closed')
        if (clientEnded || branchFinished || continuationInFlight) return
        branchFinished = true
        safeEnd('data: [DONE]\n\n')
      })
    }

    const attemptContinuation = async (
      verdict: ZaiManagedAnswerVerdict,
      danglingContent: string,
      parentMessageId: string,
    ): Promise<boolean> => {
      if (!this.continuation || clientEnded) return false
      continuationInFlight = true
      stopIdleTimer()
      try {
        const started = await this.continuation.start(verdict, danglingContent, parentMessageId)
        if (clientEnded) {
          try { started?.response?.data?.destroy?.() } catch {}
          return false
        }
        const nextStream = started?.response?.data
        if (!started || !nextStream || typeof nextStream.on !== 'function') {
          console.warn('[Z.ai] Managed workflow continuation unavailable; delivering branch as-is', JSON.stringify({
            reason: verdict.reason,
          }))
          try { nextStream?.destroy?.() } catch {}
          return false
        }
        continuationSeq += 1
        console.warn('[Z.ai] Managed workflow continuation branch attached', JSON.stringify({
          reason: verdict.reason,
          attempt: continuationSeq,
          chatId: started.chatId,
          parentMessageId: parentMessageId || '(fresh chat)',
        }))
        if (started.chatId && started.chatId !== this.chatId) this.setChatId(started.chatId)
        branchToolParser = this.toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(this.toolCallingPlan) : undefined
        branchContentStart = this.content.length
        branchFinished = false
        attachUpstream(nextStream)
        armIdleTimer()
        return true
      } catch (error) {
        console.warn('[Z.ai] Managed workflow continuation attempt failed:', error instanceof Error ? error.message : error)
        return false
      } finally {
        continuationInFlight = false
      }
    }

    const handleIdleStall = (idleMs: number) => {
      idleTimer = undefined
      if (clientEnded || continuationInFlight) return
      console.warn('[Z.ai] Upstream stream idle watchdog fired; recovering', JSON.stringify({
        chatId: this.chatId,
        idleMs,
        contentLength: this.content.length,
        lastMessageId: this.lastMessageId,
      }))
      const branchContent = this.content.slice(branchContentStart)
      if (this.toolCallingPlan?.shouldParseResponse && this.continuation) {
        // No same-chat anchor here: the upstream generation is still in
        // flight, so recovery replays the transcript in a fresh chat.
        const idleVerdict = {
          continuation: true,
          completionProofMissing: false,
          requireManagedToolCall: this.toolCallingPlan?.hasLiveToolWorkflow === true,
          reason: 'upstream_idle_stall',
        } as ZaiManagedAnswerVerdict
        void (async () => {
          const attached = await attemptContinuation(idleVerdict, branchContent, '')
          if (clientEnded) return
          if (!attached) {
            // Recovery is configured but exhausted: a partial answer over a
            // live workflow is still a stalled turn, so fail the stream for a
            // client-side retry instead of delivering a fake-success stop.
            failStreamAfterExhaustedRecovery(idleVerdict.reason)
          }
        })()
        return
      }
      writeVisibleNotice(`\n\n[Z.ai] Upstream stream was idle for ${Math.round(idleMs / 1000)}s; ending the response.`)
      finishStream('stop')
    }

    const armIdleTimer = () => {
      stopIdleTimer()
      const idleMs = zaiStreamIdleTimeoutMsFromEnv()
      if (idleMs <= 0) return
      idleTimer = setTimeout(() => handleIdleStall(idleMs), idleMs)
      // A stalled upstream must not keep the process alive by itself.
      idleTimer.unref?.()
    }

    const handleDone = (result: any) => {
      if (branchFinished || clientEnded) return
      branchFinished = true
      stopIdleTimer()
      console.log('[Z.ai] Stream finished, content length:', this.content.length)

      // Flush any remaining tool calls
      const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
      const flushChunks = branchToolParser?.flush(baseChunk) ?? []

      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }

      // Check if we emitted tool calls
      const emittedToolCalls = branchToolParser?.hasEmittedToolCall() ?? false
      // Managed-tool governance: classify dangling answers that neither call a
      // tool nor prove completion, matching the Qwen classification rules.
      const branchContent = this.content.slice(branchContentStart)
      const verdict = classifyZaiManagedAnswer(branchContent, this.toolCallingPlan, {
        isRecoveryBranch: continuationSeq > 0,
        trailingAssistantText: this.trailingAssistantText,
      })
      const usage = result.usage || { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

      if (!emittedToolCalls && verdict.continuation) {
        console.warn('[Z.ai] Managed answer classified as dangling stall; starting managed workflow continuation', JSON.stringify({
          reason: verdict.reason,
          contentLength: branchContent.length,
          lastMessageId: this.lastMessageId,
        }))
        void (async () => {
          const attached = await attemptContinuation(verdict, branchContent, this.lastMessageId)
          if (clientEnded) return
          if (!attached) {
            // Recovery configured but exhausted: a clean stop would deliver
            // the dangling answer as a final message and end the agent turn
            // silently — fail the stream for a client-side retry instead.
            // Without a continuation handle (recovery explicitly absent) the
            // legacy deliver-as-is contract stays.
            if (this.continuation) {
              failStreamAfterExhaustedRecovery(verdict.reason)
              return
            }
            finishStream('stop', usage)
          }
        })()
        return
      }
      if (!emittedToolCalls && verdict.reason === 'completion_marker_missing_live_workflow') {
        // Deliberate divergence from the Qwen classifier: a substantive
        // marker-less final over a live workflow is delivered as-is because
        // re-prompting would duplicate already-streamed text.
        console.info('[Z.ai] Delivering substantive marker-less live-workflow answer as-is', JSON.stringify({ reason: verdict.reason }))
      }
      finishStream(emittedToolCalls ? 'tool_calls' : 'stop', usage)
    }

    const handleUpstreamError = (result: any, data: any) => {
      if (branchFinished || clientEnded) return
      branchFinished = true
      stopIdleTimer()
      const error = result.error || data.error
      console.error('[Z.ai] Stream error:', error)
      console.error('[Z.ai] Stream error event (full):', JSON.stringify(data))
      if (isCaptchaRequiredError(error) && !clientEnded) {
        console.log('[Z.ai] Captcha required detected in stream, attempting auto-solve...')
        transStream.write(
          `data: ${JSON.stringify({
            id: this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: '\n[Captcha required - auto-solving, please retry your request...]' }, finish_reason: 'stop' }],
            created: this.created,
          })}\n\n`
        )
        safeEnd('data: [DONE]\n\n')
        // Trigger background captcha solve
        const acctId = this.accountId || ''
        const acctToken = this.accountToken || ''
        if (acctId && acctToken) {
          solveCaptchaAndUpdateAccount(acctId, acctToken).then(ok => {
            console.log('[Z.ai] Background captcha solve result:', ok ? 'success' : 'failed')
          }).catch(e => console.error('[Z.ai] Background captcha solve error:', e))
        }
      } else {
        transStream.write(
          `data: ${JSON.stringify({
            id: this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: `\nError: ${error.detail || JSON.stringify(error)}` }, finish_reason: 'stop' }],
            created: this.created,
          })}\n\n`
        )
        safeEnd('data: [DONE]\n\n')
      }
    }

    const handleEvent = (event: any) => {
      try {
        if (event.data === '[DONE]') return

        // First frames show the delta shape; done frames show where the
        // upstream puts the assistant message id and usage.
        const debugWorthy = zaiDebugFrameCounter < 8 || /"done"\s*:\s*true/.test(event.data)
        if (zaiDebugStreamFromEnv() && debugWorthy) {
          zaiDebugFrameCounter += 1
          console.log('[Z.ai] DEBUG upstream frame', zaiDebugFrameCounter, ':', event.data.slice(0, 800))
        }

        const data = JSON.parse(event.data)

        if (data.type !== 'chat:completion') return

        const result = data.data
        if (!result) return

        // Extract message ID from response for multi-turn support
        if (result.id && result.role === 'assistant' && !this.lastMessageId) {
          this.lastMessageId = result.id
          console.log('[Z.ai] Extracted assistant message id:', this.lastMessageId)
        }

        if (result.phase === 'thinking' && result.delta_content) {
          const cleanedContent = cleanSearchCitationsWithBuffer(result.delta_content, this.thinkingCitationBuffer)
          if (!cleanedContent) return
          // Output thinking content as reasoning_content
          if (!this.sentThinkingRole) {
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                created: this.created,
              })}\n\n`
            )
            this.sentThinkingRole = true
          }
          transStream.write(
            `data: ${JSON.stringify({
              id: this.chatId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { reasoning_content: cleanedContent }, finish_reason: null }],
              created: this.created,
            })}\n\n`
          )
        } else if (result.phase === 'answer' && result.delta_content) {
          const cleanedContent = cleanSearchCitationsWithBuffer(result.delta_content, this.citationBuffer)
          if (!cleanedContent) return
          this.content += cleanedContent

          // Process tool call interception
          const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
          const outputChunks = branchToolParser
            ? branchToolParser.push(cleanedContent, baseChunk, !this.sentRole && !this.sentThinkingRole)
            : (cleanedContent
                ? [{
                    ...baseChunk,
                    choices: [{
                      index: 0,
                      delta: {
                        ...(!this.sentRole && !this.sentThinkingRole ? { role: 'assistant' } : {}),
                        content: cleanedContent,
                      },
                      finish_reason: null,
                    }],
                  }]
                : [])

          for (const outChunk of outputChunks) {
            transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
          }

          if (outputChunks.length > 0) this.sentRole = true
        } else if (result.phase === 'done' && result.done) {
          handleDone(result)
        } else if (result.error || data.error) {
          handleUpstreamError(result, data)
        }
      } catch (err) {
        console.error('[Z.ai] Stream parse error:', err)
      }
    }

    armIdleTimer()
    attachUpstream(stream)

    return transStream
  }

  private collectNonStreamResponse(response: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let resolved = false
      let reasoningContent = ''
      const resolveOnce = (result: any) => {
        if (resolved) return
        resolved = true
        if (reasoningContent) {
          result.choices[0].message.reasoning_content = reasoningContent
        }
        resolve(result)
      }

      const rejectOnce = (err: Error) => {
        if (resolved) return
        resolved = true
        reject(err)
      }

      setTimeout(() => {
        if (!resolved) {
          console.log('[Z.ai] Non-stream timeout, resolving with current data, content length:', data.choices[0].message.content.length)
          resolveOnce(data)
        }
      }, 60000)

      // Parameter is already response.data from forwarder.ts
      const streamData = response

      // Check if streamData is a stream or JSON
      console.log('[Z.ai] Non-stream: streamData type:', typeof streamData)
      console.log('[Z.ai] Non-stream: streamData.on type:', typeof streamData?.on)
      console.log('[Z.ai] Non-stream: streamData is function?', typeof streamData?.on === 'function')
      if (streamData && typeof streamData.on === 'function') {
        console.log('[Z.ai] Non-stream: taking stream path')
        // Stream response - use buffers for citation cleaning
        const thinkingBuffer = { value: '' }
        const answerBuffer = { value: '' }
        const parser = createParser({
          onEvent: (event: any) => {
            try {
              if (event.data === '[DONE]') return

              const eventData = JSON.parse(event.data)

              if (eventData.type !== 'chat:completion') return

              const result = eventData.data
              if (!result) return

              if (result.id && result.role === 'assistant' && !this.lastMessageId) {
                this.lastMessageId = result.id
                console.log('[Z.ai] Extracted assistant message id:', this.lastMessageId)
              }

              if (result.phase === 'thinking' && result.delta_content) {
                reasoningContent += cleanSearchCitationsWithBuffer(result.delta_content, thinkingBuffer)
              } else if (result.phase === 'answer' && result.delta_content) {
                data.choices[0].message.content += cleanSearchCitationsWithBuffer(result.delta_content, answerBuffer)
              } else if (result.phase === 'done' && result.done) {
                console.log('[Z.ai] Non-stream finished, content length:', data.choices[0].message.content.length)
                if (result.usage) {
                  data.usage = result.usage
                }
                resolveOnce(data)
              } else if (result.error || eventData.error) {
                const error = result.error || eventData.error
                console.error('[Z.ai] Non-stream error event (full):', JSON.stringify(eventData))
                if (isCaptchaRequiredError(error)) {
                  console.log('[Z.ai] Captcha required detected in non-stream, attempting auto-solve...')
                  const acctId = this.accountId || ''
                  const acctToken = this.accountToken || ''
                  if (acctId && acctToken) {
                    solveCaptchaAndUpdateAccount(acctId, acctToken).then(ok => {
                      console.log('[Z.ai] Non-stream captcha solve result:', ok ? 'success' : 'failed')
                    }).catch(e => console.error('[Z.ai] Non-stream captcha solve error:', e))
                  }
                  data.choices[0].message.content += '\n[Captcha required - auto-solving, please retry your request]'
                } else {
                  data.choices[0].message.content += `\nError: ${error.detail || JSON.stringify(error)}`
                }
                resolveOnce(data)
              }
            } catch (err) {
              console.error('[Z.ai] Non-stream parse error:', err)
              rejectOnce(err instanceof Error ? err : new Error(String(err)))
            }
          },
        })

        streamData.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
        streamData.once('error', rejectOnce)
        streamData.once('close', () => {
          console.log('[Z.ai] Non-stream closed, resolving with current data, content length:', data.choices[0].message.content.length)
          resolveOnce(data)
        })
      } else if (streamData) {
        // JSON response - parse directly
        try {
          // Handle SSE format in JSON response
          if (typeof streamData === 'string') {
            let content = ''
            let reasoning = ''
            const thinkingBuffer = { value: '' }
            const answerBuffer = { value: '' }
            const lines = streamData.split('\n')
            for (const line of lines) {
              if (line.startsWith('data:')) {
                const jsonStr = line.substring(5).trim()
                if (jsonStr === '[DONE]') continue
                try {
                  const event = JSON.parse(jsonStr)
                  if (event.type === 'chat:completion' && event.data) {
                    if (event.data.phase === 'thinking' && event.data.delta_content) {
                      reasoning += cleanSearchCitationsWithBuffer(event.data.delta_content, thinkingBuffer)
                    } else if (event.data.phase === 'answer' && event.data.delta_content) {
                      content += cleanSearchCitationsWithBuffer(event.data.delta_content, answerBuffer)
                    } else if (event.data.phase === 'done' && event.data.done) {
                      if (event.data.usage) {
                        data.usage = event.data.usage
                      }
                    }
                  }
                } catch (e) {
                  // Ignore parse errors for individual lines
                }
              }
            }
            data.choices[0].message.content = content
            if (reasoning) {
              data.choices[0].message.reasoning_content = reasoning
            }
          } else {
            // Direct JSON object
            data.choices[0].message.content = streamData.choices?.[0]?.message?.content || ''
          }

          console.log('[Z.ai] Non-stream JSON finished, content length:', data.choices[0].message.content.length)
          resolveOnce(data)
        } catch (err) {
          console.error('[Z.ai] Non-stream JSON parse error:', err)
          rejectOnce(err instanceof Error ? err : new Error(String(err)))
        }
      } else {
        console.log('[Z.ai] Non-stream: streamData is falsy, taking empty path')
        resolveOnce(data)
      }
    })
  }

  async handleNonStream(response: any): Promise<any> {
    console.log('[Z.ai] Starting non-stream handler...')

    const result = await this.collectNonStreamResponse(response)
    if (!this.toolCallingPlan?.shouldParseResponse || !this.continuation) {
      return result
    }

    // Managed workflow continuation for the buffered path: a classified
    // dangling answer is recovered with a replacement branch whose text is
    // appended to the collected content; the forwarder parses the final text
    // for tool calls afterwards (applyToolCallsToResponse).
    for (let guard = 0; guard < 3; guard += 1) {
      const content: string = result.choices?.[0]?.message?.content || ''
      const verdict = classifyZaiManagedAnswer(content, this.toolCallingPlan, {
        isRecoveryBranch: guard > 0,
        trailingAssistantText: this.trailingAssistantText,
      })
      if (!verdict.continuation) break

      console.warn('[Z.ai] Non-stream managed answer classified as dangling stall; starting managed workflow continuation', JSON.stringify({
        reason: verdict.reason,
        contentLength: content.length,
        lastMessageId: this.lastMessageId,
      }))
      const started = await this.continuation.start(verdict, content, this.lastMessageId)
      if (!started) {
        console.warn('[Z.ai] Managed workflow continuation unavailable; delivering dangling answer as-is', JSON.stringify({ reason: verdict.reason }))
        break
      }

      const next = await this.collectNonStreamResponse(started.response)
      const nextContent: string = next.choices?.[0]?.message?.content || ''
      const nextReasoning: string = next.choices?.[0]?.message?.reasoning_content || ''
      if (nextContent) {
        result.choices[0].message.content = content ? `${content}\n\n${nextContent}` : nextContent
      }
      if (nextReasoning) {
        const prevReasoning: string = result.choices[0].message.reasoning_content || ''
        result.choices[0].message.reasoning_content = prevReasoning ? `${prevReasoning}\n\n${nextReasoning}` : nextReasoning
      }
      if (next.usage) {
        result.usage = next.usage
      }
    }
    return result
  }

  getChatId(): string {
    return this.chatId
  }
}

export const zaiAdapter = {
  ZaiAdapter,
  ZaiStreamHandler,
}
