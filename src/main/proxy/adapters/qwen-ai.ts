/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types'
import { hasToolUse, parseToolUse } from '../promptToolUse'
import { QwenAiTokenRefresher } from './qwen-ai-token-refresh'
import { QwenAiFileUploader, QWEN_AI_DOCUMENT_EVIDENCE_MARKER, prepareQwenAiMultimodalMessage } from './qwen-ai-files'
import { createBaseChunk } from '../utils/streamToolHandler'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import type { ToolCall } from '../types'
import {
  isCompleteJsonText,
  mergeNativeToolArguments,
  normalizeNativeFunctionCallDelta,
  type NativeToolCallState,
} from './qwen-ai-native-tools'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const QWEN_AI_REQUEST_TIMEOUT_MS = Number(process.env.QWEN_AI_REQUEST_TIMEOUT_MS || 300000)

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Version: '0.2.67',
  Origin: 'https://chat.qwen.ai',
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3.6-35b': 'qwen3.6-35b-a3b',
  'qwen3.6-27b': 'qwen3.6-27b',
  'qwen3-coder': 'qwen3-coder-plus',
}

type QwenAiMessage = ChatMessage

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  chatId?: string
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

function currentTimezoneHeader(): string {
  return new Date().toString().replace(/\s*\(.+\)$/, '')
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private tokenRefresher = new QwenAiTokenRefresher()
  private axiosInstance = axios.create({
    timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    this.account = await this.tokenRefresher.refreshIfNeeded(this.account)
  }

  private async postWithRefreshRetry(
    url: string,
    payload: unknown,
    createOptions: () => Record<string, any>,
  ): Promise<AxiosResponse> {
    let response = await this.axiosInstance.post(url, payload, createOptions())

    if (response.status === 401) {
      this.account = await this.tokenRefresher.refreshAfterUnauthorized(this.account)
      response = await this.axiosInstance.post(url, payload, createOptions())
    }

    return response
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    const cookies = credentials.cookies || credentials.cookie || ''
    if (typeof cookies === 'string') {
      return cookies
    }
    if (isObjectValue(cookies)) {
      return Object.entries(cookies)
        .filter(([, value]) => typeof value === 'string' && value)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
    }
    return ''
  }

  private getCredentialValue(...keys: string[]): string {
    const credentials = this.account.credentials
    for (const key of keys) {
      const value = credentials[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return ''
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const cookies = this.getCookies()
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'X-Request-Id': uuid(),
      Timezone: currentTimezoneHeader(),
    }

    const token = this.getToken()
    // The current Qwen web frontend sets source=web and removes Authorization for
    // browser sessions. Sending browser cookies together with desktop bearer auth
    // is more likely to hit upstream risk control.
    if (token && !cookies) {
      headers.source = 'desktop'
      headers.Authorization = `Bearer ${token}`
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const baxiaUidToken = this.getCredentialValue('baxiaUidToken', 'baxia_uid_token', 'uidToken')
    if (baxiaUidToken) {
      headers['bx-umidtoken'] = baxiaUidToken
    }

    const baxiaUa = this.getCredentialValue('baxiaUa', 'baxia_ua', 'bxUa', 'bx_ua')
    if (baxiaUa) {
      headers['bx-ua'] = baxiaUa
    }

    const baxiaVersion = this.getCredentialValue('baxiaVersion', 'baxia_version', 'bxV', 'bx_v')
    if (baxiaVersion) {
      headers['bx-v'] = baxiaVersion
    }

    const x5secdata = this.getCredentialValue('x5secdata')
    if (x5secdata) {
      headers['x5secdata'] = x5secdata
    }

    const x5sectag = this.getCredentialValue('x5sectag')
    if (x5sectag) {
      headers['x5sectag'] = x5sectag
    }

    if (cookies) {
      headers['Cookie'] = cookies
    } else {
      console.warn('[QwenAI] Warning: No cookies provided. This may cause Bad_Request error.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  private sanitizeHeadersForLog(headers: Record<string, any>): Record<string, unknown> {
    const sensitiveHeaders = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'bx-ua',
      'bx-umidtoken',
      'x5secdata',
      'x5sectag',
    ])

    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        sensitiveHeaders.has(key.toLowerCase()) ? '[REDACTED]' : value,
      ]),
    )
  }

  private sanitizePayloadForLog(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.sanitizePayloadForLog(item))
    }

    if (typeof value === 'string' && value.includes(QWEN_AI_DOCUMENT_EVIDENCE_MARKER)) {
      return `${value.slice(0, value.indexOf(QWEN_AI_DOCUMENT_EVIDENCE_MARKER))}${QWEN_AI_DOCUMENT_EVIDENCE_MARKER}\n[REDACTED_DOCUMENT_EVIDENCE]`
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          key === 'url' ? '[REDACTED_URL]' : this.sanitizePayloadForLog(item),
        ]),
      )
    }

    return value
  }

  private async readStreamPreview(stream: any, maxBytes = 4096): Promise<string> {
    if (!stream) return ''
    if (typeof stream === 'string') return stream.slice(0, maxBytes)
    if (Buffer.isBuffer(stream)) return stream.toString('utf8', 0, maxBytes)
    if (typeof stream !== 'object' || typeof stream.on !== 'function') {
      try {
        return JSON.stringify(stream).slice(0, maxBytes)
      } catch {
        return String(stream).slice(0, maxBytes)
      }
    }

    const chunks: Buffer[] = []
    let total = 0

    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }

      stream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const remaining = maxBytes - total
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining))
          total += Math.min(buffer.length, remaining)
        }
        if (total >= maxBytes && typeof stream.destroy === 'function') {
          stream.destroy()
        }
      })
      stream.once('end', finish)
      stream.once('close', finish)
      stream.once('error', finish)
    })

    return Buffer.concat(chunks).toString('utf8')
  }

  private extractUpstreamErrorMessage(body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return ''

    try {
      const parsed = JSON.parse(trimmed)
      const ret = Array.isArray(parsed?.ret)
        ? parsed.ret.filter((item: unknown) => typeof item === 'string' && item.trim()).join('; ')
        : ''
      const message =
        parsed?.message ||
        parsed?.msg ||
        parsed?.error?.message ||
        parsed?.data?.message ||
        parsed?.data?.msg ||
        ret
      if (typeof message === 'string' && message.trim()) {
        return message.trim()
      }
    } catch {
      // Fall back to a compact body preview below.
    }

    return trimmed
      .replace(/https?:\/\/[^\s"',}]+/gi, '[REDACTED_URL]')
      .replace(/(x5secdata|x5sectag|cookie|authorization|token)=([^&\s"',}]+)/gi, '$1=[REDACTED]')
      .replace(/\s+/g, ' ')
      .slice(0, 500)
  }

  private hasRiskControlHeaders(headers: Record<string, any>): boolean {
    const setCookie = headers['set-cookie']
    const setCookieText = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie || '')

    return Boolean(
      headers.bxpunish ||
      headers['bxpunish'] ||
      headers['x5secdata'] ||
      headers['x5sectag'] ||
      /x5sec/i.test(setCookieText),
    )
  }

  private isRiskControlMessage(message: string): boolean {
    return /FAIL_SYS_USER_VALIDATE|RGV587|risk-control|challenge|captcha|x5sec|baxia|punish|哎哟喂|被挤爆/i.test(message)
  }

  private async createInvalidStreamError(response: AxiosResponse, reason: string): Promise<Error> {
    const contentType = String(response.headers?.['content-type'] || 'unknown')
    const body = await this.readStreamPreview(response.data)
    const upstreamMessage = this.extractUpstreamErrorMessage(body)
    const detail = upstreamMessage ? `: ${upstreamMessage}` : ''

    const error = new Error(`Qwen AI upstream ${reason} (HTTP ${response.status}, content-type ${contentType})${detail}`)
    if (this.isRiskControlMessage(upstreamMessage) || reason.includes('risk-control')) {
      ;(error as Error & { status?: number; code?: string }).status = 403
      ;(error as Error & { status?: number; code?: string }).code = 'qwen_ai_risk_control'
    }
    return error
  }

  private async assertChatCompletionStreamResponse(response: AxiosResponse): Promise<void> {
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()

    if (response.status >= 400) {
      throw await this.createInvalidStreamError(response, `returned HTTP ${response.status}`)
    }

    if (this.hasRiskControlHeaders(response.headers || {})) {
      throw await this.createInvalidStreamError(response, 'returned a risk-control or challenge response instead of a chat event stream')
    }

    if (contentType.includes('application/json') || contentType.includes('text/html')) {
      throw await this.createInvalidStreamError(response, 'returned a non-stream response instead of a chat event stream')
    }
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(modelId: string, title: string = 'New Chat'): Promise<string> {
    await this.refreshTokenIfNeeded()

    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.postWithRefreshRetry(url, payload, () => ({
        headers: this.getHeaders(),
        validateStatus: () => true,
      }))

      console.log('[QwenAI] Create chat response:', JSON.stringify(response.data, null, 2))

      if (response.data?.data?.id) {
        console.log('[QwenAI] Created chat:', response.data.data.id)
        return response.data.data.id
      }

      throw new Error('Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', error)
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', error)
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', error)
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    await this.refreshTokenIfNeeded()

    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.6-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    // Always create a new chat (single-turn mode only)
    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat')
    console.log('[QwenAI] Created new chat:', chatId)

    const messages = request.messages
    const uploader = new QwenAiFileUploader(
      this.axiosInstance,
      () => this.getHeaders(chatId),
      this.postWithRefreshRetry.bind(this),
    )
    const preparedUserMessage = await prepareQwenAiMultimodalMessage(messages, uploader)
    const qwenFiles = preparedUserMessage.files

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // Default to disable thinking mode to avoid automatic reasoning trigger
    // Users can control thinking via:
    // 1. Model name suffix: -thinking (force thinking), -fast (force fast mode)
    // 2. enable_thinking parameter for explicit control
    // 3. If neither is specified, thinking mode is disabled by default (fast mode)
    const shouldEnableThinking = forceThinking !== undefined 
      ? forceThinking 
      : request.enable_thinking === true
    
    const featureConfig: Record<string, any> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false, // Default to disable auto search
    }

    if (request.thinking_budget) {
      featureConfig.thinking_budget = request.thinking_budget
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: preparedUserMessage.content,
          user_action: 'chat',
          files: qwenFiles,
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

    console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
    console.log('[QwenAI] Request URL:', url)
    console.log('[QwenAI] Request payload:', JSON.stringify(this.sanitizePayloadForLog(payload), null, 2))
    console.log('[QwenAI] Request headers:', JSON.stringify(this.sanitizeHeadersForLog(this.getHeaders(chatId)), null, 2))

    const response = await this.postWithRefreshRetry(url, payload, () => ({
      headers: {
        ...this.getHeaders(chatId),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    }))

    console.log('[QwenAI] Response status:', response.status)
    console.log('[QwenAI] Response headers:', JSON.stringify(this.sanitizeHeadersForLog(response.headers), null, 2))

    await this.assertChatCompletionStreamResponse(response)

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private toolCallsSent: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private nativeToolCallStates = new Map<string, NativeToolCallState>()
  private nativeToolCallIndex = 0
  private ignoredResponseIds = new Set<string>()
  private responseBranchLocked = false
  private processedResponseEvent = false

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

  private getResponseIndex(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    return String(value)
  }

  private getEventResponseId(data: Record<string, any>): string {
    const responseId = data.response_id ?? data['response.created']?.response_id
    return typeof responseId === 'string' ? responseId : ''
  }

  private getEventResponseIndex(data: Record<string, any>): string | undefined {
    return this.getResponseIndex(data.response_index ?? data['response.created']?.response_index)
  }

  private hasStartedResponseOutput(): boolean {
    return Boolean(this.processedResponseEvent || this.content || this.toolCallsSent || this.nativeToolCallStates.size > 0)
  }

  private setPrimaryResponseBranch(responseId: string, responseIndex?: string): void {
    this.responseId = responseId
    this.ignoredResponseIds.delete(responseId)

    if (responseIndex === '0') {
      this.responseBranchLocked = true
    }

    console.log('[QwenAI] Got response_id:', this.responseId, 'response_index:', responseIndex ?? 'unknown')
  }

  private ignoreResponseBranch(responseId: string, responseIndex?: string): void {
    if (!responseId) return

    const firstIgnoredEvent = !this.ignoredResponseIds.has(responseId)
    this.ignoredResponseIds.add(responseId)

    if (firstIgnoredEvent) {
      console.warn('[QwenAI] Ignoring secondary response branch:', {
        responseId,
        responseIndex: responseIndex ?? 'unknown',
        primaryResponseId: this.responseId || 'unselected',
      })
    }
  }

  private recordResponseCreated(created: Record<string, any>): void {
    const responseId = typeof created.response_id === 'string' ? created.response_id : ''
    if (!responseId) return

    const responseIndex = this.getResponseIndex(created.response_index)

    if (!this.responseId) {
      if (responseIndex && responseIndex !== '0') {
        this.ignoreResponseBranch(responseId, responseIndex)
        return
      }

      this.setPrimaryResponseBranch(responseId, responseIndex)
      return
    }

    if (responseId === this.responseId) {
      if (responseIndex === '0') {
        this.responseBranchLocked = true
      }
      return
    }

    if (responseIndex === '0' && !this.responseBranchLocked && !this.hasStartedResponseOutput()) {
      this.ignoreResponseBranch(this.responseId, undefined)
      this.setPrimaryResponseBranch(responseId, responseIndex)
      return
    }

    this.ignoreResponseBranch(responseId, responseIndex)
  }

  private shouldProcessResponseEvent(data: Record<string, any>): boolean {
    const eventResponseId = this.getEventResponseId(data)
    const eventResponseIndex = this.getEventResponseIndex(data)

    if (!eventResponseId) {
      if (eventResponseIndex && eventResponseIndex !== '0') {
        console.warn('[QwenAI] Ignoring secondary response branch without response_id:', {
          responseIndex: eventResponseIndex,
          primaryResponseId: this.responseId || 'unselected',
        })
        return false
      }

      this.processedResponseEvent = true
      return true
    }

    if (this.ignoredResponseIds.has(eventResponseId)) {
      return false
    }

    if (!this.responseId) {
      if (eventResponseIndex && eventResponseIndex !== '0') {
        this.ignoreResponseBranch(eventResponseId, eventResponseIndex)
        return false
      }

      this.setPrimaryResponseBranch(eventResponseId, eventResponseIndex)
      this.processedResponseEvent = true
      return true
    }

    if (eventResponseId !== this.responseId) {
      this.ignoreResponseBranch(eventResponseId, eventResponseIndex)
      return false
    }

    this.processedResponseEvent = true
    return true
  }

  private sendToolCalls(transStream: PassThrough): boolean {
    if (this.toolCallsSent) return true
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
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
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
      return true
    }

    return false
  }

  private ingestNativeToolCallFragments(delta: Record<string, any>): boolean {
    if (!this.toolCallingPlan?.shouldParseResponse) return false

    const fragments = normalizeNativeFunctionCallDelta(delta)
    let sawFragment = false

    for (const fragment of fragments) {
      sawFragment = true
      const existing = this.nativeToolCallStates.get(fragment.key)
      const name = fragment.name || existing?.name || ''
      const allowed = Boolean(name && this.toolCallingPlan.allowedToolNames.has(name))
      const nextState: NativeToolCallState = {
        key: fragment.key,
        id: fragment.id || existing?.id || `call_${this.nativeToolCallIndex}`,
        index: fragment.index ?? existing?.index ?? this.nativeToolCallIndex,
        name,
        arguments: mergeNativeToolArguments(existing?.arguments ?? '', fragment.arguments),
        allowed,
      }

      if (!existing) {
        this.nativeToolCallIndex += 1
      }

      this.nativeToolCallStates.set(fragment.key, nextState)

      if (name && !allowed) {
        console.warn('[QwenAI] Ignoring undeclared upstream native tool call:', name)
      }
    }

    return sawFragment
  }

  private getCompleteNativeToolCalls(force: boolean = false): ToolCall[] {
    const toolCalls: ToolCall[] = []

    for (const state of this.nativeToolCallStates.values()) {
      if (!state.allowed || !state.name) continue
      if (!force && !isCompleteJsonText(state.arguments)) continue

      toolCalls.push({
        index: state.index,
        id: state.id,
        type: 'function',
        function: {
          name: state.name,
          arguments: state.arguments,
        },
      })
    }

    return toolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  }

  private emitNativeToolCalls(transStream: PassThrough, toolCalls: ToolCall[]): boolean {
    if (this.toolCallsSent || toolCalls.length === 0) return false

    this.toolCallsSent = true

    for (let i = 0; i < toolCalls.length; i += 1) {
      const toolCall = toolCalls[i]
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: i === 0 ? 'assistant' : undefined,
              tool_calls: [toolCall],
            },
            finish_reason: null,
          }],
          created: this.created,
        })}\n\n`,
      )
    }

    transStream.write(
      `data: ${JSON.stringify({
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        created: this.created,
      })}\n\n`,
    )
    transStream.end('data: [DONE]\n\n')

    if (this.onEnd && this.chatId) {
      this.onEnd(this.chatId)
    }

    return true
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[QwenAI] Starting stream handler...')

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let initialChunkSent = false
    let finalChunkSent = false

    const writeContent = (content: string) => {
      if (!content || finalChunkSent) return

      this.content += content

      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const outputChunks = this.toolStreamParser?.push(content, baseChunk, !initialChunkSent) ?? [
        {
          ...baseChunk,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        },
      ]

      for (const outputChunk of outputChunks) {
        transStream.write(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }

      if (outputChunks.length > 0) {
        initialChunkSent = true
        console.log('[QwenAI] Content/tool chunk written')
      }
    }

    const finishAnswer = (finishReason: string = 'stop') => {
      if (finalChunkSent) return

      const completeNativeToolCalls = this.getCompleteNativeToolCalls(true)
      if (completeNativeToolCalls.length > 0 && this.emitNativeToolCalls(transStream, completeNativeToolCalls)) {
        finalChunkSent = true
        return
      }

      const hadPendingToolProtocol = this.toolStreamParser?.hasPendingToolProtocol() ?? false

      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outputChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }

      const recoveredToolChunks = this.toolStreamParser?.recoverFromContent(this.content, baseChunk, !initialChunkSent) ?? []
      for (const outputChunk of recoveredToolChunks) {
        transStream.write(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }
      if (recoveredToolChunks.length > 0) {
        initialChunkSent = true
        console.log('[QwenAI] Recovered tool call from accumulated answer content')
      }

      if (hasToolUse(this.content)) {
        console.log('[QwenAI] Found legacy tool_use in stream, sending tool_calls')
        if (this.sendToolCalls(transStream)) {
          finalChunkSent = true
          return
        }
      }

      if (
        this.toolCallingPlan?.shouldParseResponse &&
        !this.toolStreamParser?.hasEmittedToolCall() &&
        hadPendingToolProtocol &&
        (this.toolCallingPlan.toolChoiceMode === 'forced' || this.toolCallingPlan.toolChoiceMode === 'required')
      ) {
        const errorEvent = {
          error: {
            message: 'Provider returned a malformed or empty tool call block for a required tool call',
            type: 'tool_call_parse_error',
            param: 'tool_calls',
            code: 'malformed_tool_call',
          },
        }
        transStream.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
        transStream.write('data: [DONE]\n\n')
        transStream.end()
        finalChunkSent = true

        if (this.onEnd && this.chatId) {
          this.onEnd(this.chatId)
        }
        return
      }

      const resolvedFinishReason = this.toolStreamParser?.hasEmittedToolCall()
        ? 'tool_calls'
        : finishReason
      const finalChunk = {
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: resolvedFinishReason }],
        created: this.created,
      }
      transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
      transStream.end('data: [DONE]\n\n')
      finalChunkSent = true

      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
    }

    const sendInitialChunk = () => {
      if (!initialChunkSent && !this.toolStreamParser) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        transStream.write(initialChunk)
        initialChunkSent = true
        console.log('[QwenAI] Initial chunk written')
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          console.log('[QwenAI] Parsed event:', event.event, 'data:', event.data?.substring(0, 200))
          
          if (event.data === '[DONE]') {
            console.log('[QwenAI] Received [DONE] signal')
            return
          }

          const data = JSON.parse(event.data)
          console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))

          if (data['response.created']) {
            this.recordResponseCreated(data['response.created'])
          }

          if (data.choices && data.choices.length > 0) {
            if (!this.shouldProcessResponseEvent(data)) {
              return
            }

            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            const content = delta.content || ''

            console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content:', content.substring(0, 50))

            const sawNativeToolCall = this.ingestNativeToolCallFragments(delta)
            if (sawNativeToolCall) {
              const completeNativeToolCalls = this.getCompleteNativeToolCalls(status === 'finished')
              if (completeNativeToolCalls.length > 0 && this.emitNativeToolCalls(transStream, completeNativeToolCalls)) {
                finalChunkSent = true
                return
              }

              if (!content) {
                return
              }
            }

            if (phase === 'think') {
              if (status !== 'finished') {
                // Stream thinking content as reasoning_content in real-time
                reasoningText += content
                if (!hasSentReasoning) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                  hasSentReasoning = true
                  console.log('[QwenAI] Sent reasoning role chunk')
                }
                if (content) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                }
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              if (extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  // Send only the incremental diff as reasoning_content
                  const diff = newSummary.substring(summaryText.length)
                  if (diff) {
                    if (!hasSentReasoning) {
                      transStream.write(
                        `data: ${JSON.stringify({
                          id: this.responseId || this.chatId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`
                      )
                      hasSentReasoning = true
                    }
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.chatId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { reasoning_content: diff }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`
                    )
                  }
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer') {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              console.log('[QwenAI] Entering answer branch, content:', content)
              writeContent(content)
            } else if (phase === null && content) {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              writeContent(content)
            }

            if (status === 'finished' && (phase === 'answer' || phase === null)) {
              finishAnswer(delta.finish_reason || 'stop')
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', err)
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      const text = buffer.toString()
      console.log('[QwenAI] Raw stream data:', text.substring(0, 500))
      parser.feed(text)
    })
    stream.once('error', (err: Error) => {
      console.error('[QwenAI] Stream error:', err)
      finalChunkSent = true
      transStream.end('data: [DONE]\n\n')
    })
    stream.once('close', () => {
      console.log('[QwenAI] Stream closed')
      if (!finalChunkSent) {
        finishAnswer('stop')
      }
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
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

      let reasoningText = ''
      let summaryText = ''
      let resolved = false
      let sawAnswerFinish = false

      const resolveOnce = (value: any) => {
        if (!resolved) {
          resolved = true
          resolve(value)
        }
      }

      const rejectOnce = (reason: any) => {
        if (!resolved) {
          resolved = true
          reject(reason)
        }
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            if (event.data === '[DONE]') return

            const parsed = JSON.parse(event.data)

            if (parsed['response.created']) {
              this.recordResponseCreated(parsed['response.created'])
              if (this.responseId) {
                data.id = this.responseId
              }
            }

            if (parsed.choices && parsed.choices.length > 0) {
              if (!this.shouldProcessResponseEvent(parsed)) {
                return
              }
              if (this.responseId) {
                data.id = this.responseId
              }

              const delta = parsed.choices[0].delta || {}
              const phase = delta.phase
              const status = delta.status
              const content = delta.content || ''

              if (phase === 'think' && status !== 'finished') {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                // Handle thinking_summary phase - extract summary content
                const extra = delta.extra || {}
                if (extra.summary_thought?.content) {
                  const newSummary = extra.summary_thought.content.join('\n')
                  if (newSummary && newSummary.length > summaryText.length) {
                    summaryText = newSummary
                  }
                }
              } else if (phase === 'answer') {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  sawAnswerFinish = true
                  // Use reasoningText or summaryText for reasoning_content
                  const finalReasoning = reasoningText || summaryText
                  if (finalReasoning) {
                    data.choices[0].message.reasoning_content = finalReasoning
                  }

                  if (this.onEnd && this.chatId) {
                    this.onEnd(this.chatId)
                  }

                  resolveOnce(data)
                }
              } else if (phase === null && content) {
                data.choices[0].message.content += content
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', err)
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', (err: Error) => {
        console.error('[QwenAI] Non-stream error:', err)
        rejectOnce(err)
      })
      stream.once('close', () => {
        // Use reasoningText or summaryText for reasoning_content
        const finalReasoning = reasoningText || summaryText
        if (finalReasoning) {
          data.choices[0].message.reasoning_content = finalReasoning
        }
        const answerText = data.choices[0].message.content || ''
        const hasAnyOutput = Boolean(answerText.trim() || finalReasoning.trim())
        if (!hasAnyOutput) {
          rejectOnce(new Error('Qwen AI returned an empty response stream without answer or reasoning content'))
          return
        }
        if (!sawAnswerFinish) {
          console.warn('[QwenAI] Non-stream closed before an answer finished event; returning accumulated content.')
        }
        resolveOnce(data)
      })
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
