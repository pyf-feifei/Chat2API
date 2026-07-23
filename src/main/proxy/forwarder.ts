/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import {
  describeErrorForLog,
  QWEN_AI_STREAM_FAILURE_EVENT,
  QwenAiAdapter,
  QwenAiStreamHandler,
  type QwenAiOutputStream,
} from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { qwenAiRequestGovernor } from './qwenAiRequestGovernor'
import { BufferedSseError, bufferValidatedSseStream } from './utils/validatedSseStream'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from './utils/errors'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  SummaryGenerator,
  type ChatMessage as ContextChatMessage,
} from './services/contextManagementService'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

function statusFromError(error: unknown): number | undefined {
  const errorRecord = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const maybeStatus = errorRecord?.status
  if (typeof maybeStatus === 'number') {
    return maybeStatus
  }

  const maybeStatusCode = errorRecord?.statusCode
  if (typeof maybeStatusCode === 'number') {
    return maybeStatusCode
  }

  const responseStatus = errorRecord?.response?.status
  if (typeof responseStatus === 'number') {
    return responseStatus
  }

  const errorLike = error as { message?: unknown }
  const message = typeof errorLike?.message === 'string' ? errorLike.message : ''

  if (isClientCancellationError(error)) {
    return 499
  }

  if (/timed out|timeout|idle for more than/i.test(message)) {
    return 504
  }

  return undefined
}

function headersFromError(error: unknown): Record<string, string> | undefined {
  const headers = (error as { headers?: unknown })?.headers
  return sanitizeForwardedErrorHeaders(headers)
}

function errorCodeFromError(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && code.trim() ? code : undefined
}

function awaitQwenAiStreamPreflight(
  stream: QwenAiOutputStream,
  signal?: AbortSignal,
  maxHoldMs: number = qwenAiStreamPreflightMaxHoldMsFromEnv(),
): Promise<void> {
  if (stream.qwenAiFailure) {
    return Promise.reject(stream.qwenAiFailure)
  }

  const state = stream as QwenAiOutputStream & {
    readableLength?: number
    readableEnded?: boolean
    writableEnded?: boolean
    writableFinished?: boolean
    destroyed?: boolean
    closed?: boolean
  }
  if ((state.readableLength || 0) > 0) {
    return Promise.resolve()
  }
  if (maxHoldMs <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let holdTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      stream.removeListener('readable', onReadable)
      stream.removeListener(QWEN_AI_STREAM_FAILURE_EVENT, onFailure)
      stream.removeListener('error', onError)
      stream.removeListener('end', onEnd)
      stream.removeListener('close', onEnd)
      signal?.removeEventListener('abort', onAbort)
      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = undefined
      }
    }
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onReadable = () => {
      if (stream.qwenAiFailure) {
        settle(stream.qwenAiFailure)
        return
      }
      if ((state.readableLength || 0) > 0) {
        settle()
        return
      }
      // Some Node readable implementations emit `readable` once when an
      // empty stream is closed. Do not treat that notification as a visible
      // provider event; let the end/close handlers classify the empty stream.
      if (state.readableLength === 0) {
        // Nudge PassThrough/readable streams so an already-ended empty stream
        // emits `end` instead of waiting for a consumer to call read().
        stream.read(0)
      }
      if (
        state.readableEnded
        || state.writableEnded
        || state.writableFinished
        || state.destroyed
        || state.closed
      ) {
        onEnd()
      }
    }
    const onFailure = (error: Error) => settle(error)
    const onError = (error: Error) => settle(error)
    const onEnd = () => {
      if (stream.qwenAiFailure) {
        settle(stream.qwenAiFailure)
        return
      }
      if ((state.readableLength || 0) > 0) {
        settle()
        return
      }
      const error = new Error('Qwen AI response stream ended before producing a client-visible event') as Error & {
        status?: number
        code?: string
        retryable?: boolean
      }
      error.status = 502
      error.code = 'qwen_ai_stream_incomplete'
      error.retryable = false
      settle(error)
    }
    const onAbort = () => {
      const error = new Error('Qwen AI response stream aborted before producing a client-visible event') as Error & {
        status?: number
        retryable?: boolean
      }
      error.status = 499
      error.retryable = false
      settle(error)
    }

    stream.on('readable', onReadable)
    stream.once(QWEN_AI_STREAM_FAILURE_EVENT, onFailure)
    stream.once('error', onError)
    stream.once('end', onEnd)
    stream.once('close', onEnd)
    signal?.addEventListener('abort', onAbort, { once: true })
    holdTimer = setTimeout(() => {
      if (stream.qwenAiFailure) {
        settle(stream.qwenAiFailure)
        return
      }
      if (
        (state.readableLength || 0) === 0
        && (
          state.readableEnded
          || state.writableEnded
          || state.writableFinished
          || state.destroyed
          || state.closed
        )
      ) {
        onEnd()
        return
      }
      // The upstream is still open but has not produced a visible event.
      // Release the live response so downstream clients can observe later
      // in-band errors instead of waiting indefinitely for HTTP headers.
      settle()
    }, maxHoldMs)
    holdTimer.unref?.()

    if (stream.qwenAiFailure) {
      settle(stream.qwenAiFailure)
    } else if ((state.readableLength || 0) > 0) {
      settle()
    } else if (signal?.aborted) {
      onAbort()
    } else if (state.readableEnded) {
      onEnd()
    }
  })
}

function isQwenRiskControlText(value: string | undefined): boolean {
  return Boolean(value && /qwen_ai_risk_control|FAIL_SYS_USER_VALIDATE|RGV587|bxpunish|risk-control|challenge|captcha|x5sec|baxia|punish/i.test(value))
}

function qwenAiRetryCountFromEnv(recoverManagedToolStream: boolean): number {
  const raw = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  if (raw === undefined) return recoverManagedToolStream ? 1 : 0

  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value <= 10 ? value : 0
}

function qwenAiValidatedStreamMaxBytesFromEnv(): number {
  const fallback = 16 * 1024 * 1024
  const raw = process.env.CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES
  if (raw === undefined) return fallback

  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function qwenAiStreamPreflightMaxHoldMsFromEnv(): number {
  const fallback = 15_000
  const raw = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  if (raw === undefined) return fallback

  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function validatedSseMaxHoldMsFromEnv(): number {
  const fallback = 60_000
  const raw = process.env.CHAT2API_VALIDATED_SSE_MAX_HOLD_MS
  if (raw === undefined) return fallback

  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Full managed-tool stream validation is intentionally opt-in. Once an SSE
 * byte is sent, a later parser failure cannot be retried transparently, so
 * the normal path must preserve streaming latency and report that failure
 * in-band instead of withholding the whole response.
 */
function qwenAiBufferManagedStreamsFromEnv(): boolean {
  const raw = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  return raw !== undefined && /^(?:1|true|yes|on)$/i.test(raw.trim())
}

function requestUsesManagedTools(request: ChatCompletionRequest): boolean {
  return Boolean(request.tools?.length && request.tool_choice !== 'none')
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
    options: ForwardAttemptOptions,
  ) => Promise<ForwardResult>
}

type ForwardAttemptOptions = {
  qwenAiRecoveryBypassAccountInterval?: boolean
  attempt?: number
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardGLM(request, account, provider, actualModel, startTime),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardKimi(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen-ai',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime, context, options) =>
        qwenAiRequestGovernor.run(account.id, () =>
          this.forwardQwenAi(request, account, provider, actualModel, startTime, context),
          {
            signal: context.signal,
            recoveryBypassAccountInterval: options.qwenAiRecoveryBypassAccountInterval,
            requestId: context.requestId,
            attempt: options.attempt ?? 1,
          },
        ),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardZai(request, account, provider, actualModel, startTime),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMimo(request, account, provider, actualModel, startTime),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const bufferManagedToolStreams = QwenAiAdapter.isQwenAiProvider(provider)
      && requestUsesManagedTools(request)
      && qwenAiBufferManagedStreamsFromEnv()
    const recoverManagedToolStream = QwenAiAdapter.isQwenAiProvider(provider)
      && bufferManagedToolStreams
    const isQwenAiProvider = QwenAiAdapter.isQwenAiProvider(provider)
    const defaultManagedToolRecoveryOnly = recoverManagedToolStream
    const maxRetries = QwenAiAdapter.isQwenAiProvider(provider)
      ? recoverManagedToolStream
        ? qwenAiRetryCountFromEnv(recoverManagedToolStream)
        : 0
      : config.retryCount

    let lastError: string | undefined
    let lastStatus: number | undefined
    let lastHeaders: Record<string, string> | undefined
    let lastRetryable: boolean | undefined
    let lastErrorCode: string | undefined
    let lastAccountFault: boolean | undefined
    let previousRecoveryHint: ForwardResult['recoveryHint']
    let recoveryBypassUsed = false

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (context.signal?.aborted) {
        lastStatus = 499
        lastHeaders = undefined
        lastError = 'Client disconnected before the next request attempt.'
        lastRetryable = false
        lastAccountFault = undefined
        break
      }

      const useRecoveryBypass = attempt > 0
        && !recoveryBypassUsed
        && previousRecoveryHint === 'managed_tool_stream_validation'
      if (useRecoveryBypass) {
        recoveryBypassUsed = true
      }

      if (attempt > 0) {
        const delayCompleted = await this.delay(5000, context.signal)
        if (!delayCompleted) {
          lastStatus = 499
          lastHeaders = undefined
          lastError = 'Client disconnected during request retry backoff.'
          lastRetryable = false
          lastAccountFault = undefined
          break
        }
      }

      let modifiedRequest = request

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: processResult.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(
          modifiedRequest,
          account,
          provider,
          actualModel,
          context,
          {
            qwenAiRecoveryBypassAccountInterval: useRecoveryBypass,
            attempt: attempt + 1,
          },
        )

        if (result.success) {
          return result
        }

        lastError = result.error
        lastStatus = result.status
        lastHeaders = result.headers
        lastRetryable = result.retryable
        lastErrorCode = result.errorCode
        lastAccountFault = result.accountFault
        previousRecoveryHint = result.recoveryHint

        if (context.signal?.aborted) {
          lastAccountFault = undefined
          if (result.status !== 499) {
            lastStatus = 499
            lastError = 'Client disconnected while the request was in progress.'
            lastHeaders = undefined
            lastRetryable = false
            lastErrorCode = undefined
          }
        }

        const canRecoverManagedToolStream = recoverManagedToolStream
          && result.status === 502
          && result.recoveryHint === 'managed_tool_stream_validation'
        if (
          (result.retryable === false && !canRecoverManagedToolStream)
          || context.signal?.aborted
          || result.status === 499
          // Do not blindly retry a provider quota decision from the same
          // account. The governor records the throttle and applies backoff.
          || (isQwenAiProvider && result.status === 429)
        ) {
          break
        }

        if (
          defaultManagedToolRecoveryOnly
          && result.recoveryHint !== 'managed_tool_stream_validation'
        ) {
          break
        }

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
        lastStatus = statusFromError(error)
        lastHeaders = headersFromError(error)
        lastErrorCode = errorCodeFromError(error)
        const errorAccountFault = (error as { accountFault?: unknown })?.accountFault
        lastAccountFault = typeof errorAccountFault === 'boolean' ? errorAccountFault : undefined
        const errorRetryable = (error as { retryable?: unknown })?.retryable
        lastRetryable = lastStatus === 499
          || (isQwenAiProvider && (lastStatus === 403 || lastStatus === 429 || lastStatus === 504))
          || errorCodeFromError(error) === 'qwen_ai_risk_control'
          ? false
          : typeof errorRetryable === 'boolean'
            ? errorRetryable
            : undefined
        previousRecoveryHint = undefined
        if (context.signal?.aborted) {
          lastAccountFault = undefined
          if (lastStatus !== 499) {
            lastStatus = 499
            lastError = 'Client disconnected while the request was in progress.'
            lastHeaders = undefined
            lastRetryable = false
            lastErrorCode = undefined
          }
        }
        if (
          lastRetryable === false
          || context.signal?.aborted
          || lastStatus === 499
          || defaultManagedToolRecoveryOnly
        ) {
          break
        }
      }
    }

    return {
      success: false,
      status: lastStatus,
      headers: lastHeaders,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
      retryable: lastRetryable,
      errorCode: lastErrorCode,
      accountFault: lastAccountFault,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
    options: ForwardAttemptOptions = {},
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime, context, options)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new DeepSeekAdapter(provider, account)
      
      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = shouldDeleteSession()
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session:', error)
            }
          }
        : undefined

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        deleteSessionCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort,
        transformed.plan,
        request.model
      )
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      // Non-streaming requests need to collect stream data and convert
      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteSessionCallback) {
        await deleteSessionCallback()
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        status: statusFromError(error),
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * GLM Dedicated Forward
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new GLMAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        deep_research: transformedRequest.deep_research,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.message) {
            errorMessage = response.data.message
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // If delete session after chat is enabled, we need to handle it after stream ends
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              adapter.deleteConversation(convId).catch(err => {
                console.error('[GLM] Failed to delete session:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      let latency = Date.now() - startTime
      return {
        success: false,
        status: statusFromError(error),
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const reasoningEffort = request.reasoning_effort ?? request.reasoningEffort
      const enableWebSearch = request.web_search ?? Boolean(request.web_search_options)
      const conversationId = request.conversationId || request.conversation_id
        || request.chatId || request.chat_id
      const parentId = request.parentMessageId || request.parent_message_id
        || request.parentId || request.parent_id
      const projectId = request.projectId || request.project_id
      
      const adapter = new KimiAdapter(provider, account)
      const {
        response,
        conversationId: upstreamConversationId,
        accessToken: responseAccessToken,
      } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel || request.model,
        messages: transformed.messages,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: Boolean(reasoningEffort),
        enableWebSearch,
        reasoningEffort,
        conversationId,
        parentId,
        projectId,
        signal: context.signal,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new KimiStreamHandler(
        actualModel,
        upstreamConversationId,
        Boolean(reasoningEffort),
        transformed.plan,
        () => adapter.invalidateAccessToken(responseAccessToken),
      )
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, {
          signal: context.signal,
        })
        
        // Add delete conversation callback if needed
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const realChatId = handler.getConversationId()
            if (realChatId) {
              adapter.deleteConversation(realChatId).catch(err => {
                console.error('[Kimi] Failed to delete conversation:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: upstreamConversationId || undefined,
          // The assistant parent id is only known after the upstream stream
          // emits its message metadata.  It is included in the final SSE
          // chunk; do not return the request's old parent as a response header.
        }
      }

      const result = await handler.handleNonStream(response.data, {
        signal: context.signal,
      })

      this.applyToolCallsToResponse(result, transformed)

      if (shouldDeleteSession()) {
        const realChatId = handler.getConversationId()
        if (realChatId) {
          await adapter.deleteConversation(realChatId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
        parentMessageId: handler.getLastMessageId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      const kimiError = error as { retryable?: boolean }
      return {
        success: false,
        status: statusFromError(error),
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
        retryable: kimiError.retryable,
      }
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session:', err)
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)

      const sid = handler.getSessionId()
      if (deleteSessionCallback && sid) {
        await deleteSessionCallback(sid)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context?: ProxyContext
  ): Promise<ForwardResult> {
    const adapter = new QwenAiAdapter(provider, account)
    let activeChatId: string | undefined
    let cleanedChatId: string | undefined

    const cleanupChat = (chatId: string): void => {
      if (cleanedChatId === chatId) return
      cleanedChatId = chatId
      adapter.deleteChat(chatId).catch(err => {
        console.error('[QwenAI] Failed to delete chat:', describeErrorForLog(err))
      })
    }

    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: request.enable_thinking !== undefined
          ? request.enable_thinking
          : request.reasoning_effort !== undefined
            ? Boolean(request.reasoning_effort)
            : undefined,
        thinking_budget: request.thinking_budget,
        signal: context?.signal,
      })
      activeChatId = chatId

      let latency = Date.now() - startTime

      if (response.status >= 400) {
        const errorMessage = this.extractErrorMessage(response)
        const errorCode = isQwenRiskControlText(errorMessage) ? 'qwen_ai_risk_control' : undefined
        cleanupChat(chatId)
        return {
          success: false,
          status: response.status,
          headers: sanitizeForwardedErrorHeaders(response.headers),
          error: errorMessage || `HTTP ${response.status}`,
          errorCode,
          retryable: response.status === 403
            || response.status === 429
            || response.status === 499
            || response.status === 504
            || errorCode === 'qwen_ai_risk_control'
            ? false
            : undefined,
          latency,
        }
      }

      const handler = new QwenAiStreamHandler(actualModel, undefined, transformed.plan)
      handler.setChatId(chatId)

      if (request.stream) {
        let transformedStream: any = await handler.handleStream(response.data, {
          signal: context?.signal,
          onFailure: () => cleanupChat(chatId),
        })

        // Keep the HTTP status mutable until Qwen produces the first visible
        // event. Failures before that point can cross protocol bridges with
        // their real status; failures after output remain stream-local and are
        // never replayed automatically.
        await awaitQwenAiStreamPreflight(transformedStream, context?.signal)

        if (transformed.plan.shouldParseResponse && qwenAiBufferManagedStreamsFromEnv()) {
          transformedStream = await bufferValidatedSseStream(transformedStream, {
            maxBytes: qwenAiValidatedStreamMaxBytesFromEnv(),
            maxHoldMs: validatedSseMaxHoldMsFromEnv(),
            signal: context?.signal,
            forwardEvents: [QWEN_AI_STREAM_FAILURE_EVENT],
            forwardProperties: ['qwenAiFailure'],
          })
          latency = Date.now() - startTime
        }

        if (shouldDeleteSession()) {
          let cleanupRequested = false
          const cleanupCompletedStream = () => {
            if (cleanupRequested) return
            cleanupRequested = true
            cleanupChat(chatId)
          }
          const streamState = transformedStream as {
            readableEnded?: boolean
            writableFinished?: boolean
            destroyed?: boolean
            closed?: boolean
          }
          if (
            streamState.readableEnded
            || streamState.writableFinished
            || streamState.destroyed
            || streamState.closed
          ) {
            cleanupCompletedStream()
          } else {
            transformedStream.once('end', cleanupCompletedStream)
            transformedStream.once('finish', cleanupCompletedStream)
            transformedStream.once('close', cleanupCompletedStream)
            transformedStream.once('error', cleanupCompletedStream)
          }
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data, {
        signal: context?.signal,
      })

      this.applyToolCallsToResponse(result, transformed)

      if (shouldDeleteSession()) {
        await adapter.deleteChat(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      if (activeChatId) {
        cleanupChat(activeChatId)
      }
      let latency = Date.now() - startTime
      const status = context?.signal?.aborted ? 499 : statusFromError(error)
      const recoveryHint = error instanceof BufferedSseError && (
        error.type === 'tool_call_parse_error'
        || error.code === 'qwen_ai_stream_incomplete'
        || error.code === 'qwen_ai_empty_stream'
      )
        ? 'managed_tool_stream_validation' as const
        : undefined
      const errorCode = errorCodeFromError(error)
      const upstreamRetryable = (error as { retryable?: unknown })?.retryable
      const upstreamAccountFault = (error as { accountFault?: unknown })?.accountFault
      const retryable = status === 499
        || status === 403
        || status === 429
        || status === 504
        || errorCode === 'qwen_ai_risk_control'
        ? false
        : typeof upstreamRetryable === 'boolean'
          ? upstreamRetryable
          : undefined
      return {
        success: false,
        status,
        headers: headersFromError(error),
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
        retryable,
        errorCode,
        accountFault: typeof upstreamAccountFault === 'boolean' ? upstreamAccountFault : undefined,
        recoveryHint,
      }
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardZai] actualModel:', actualModel)
    console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat:', error)
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback)
      handler.setChatId(chatId)
      
      if (request.stream === true) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        this.applyToolCallsToResponse(response.data, transformed)
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: response.data,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session:', error)
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(response.data)

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            await adapter.generateConversationTitle(
              conversationId,
              query,
              handler.getAssistantContentForTitle()
            )
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error:', error)
            transformedStream.end()
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      const result = await handler.handleNonStream(response.data)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      await adapter.generateConversationTitle(
        conversationId,
        query,
        handler.getAssistantContentForTitle()
      )
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      console.error('[Mimo] Forward error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter)
      const result = await handler.handleNonStream(stream)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    if (request.tools !== undefined) {
      body.tools = request.tools
    }

    if (request.tool_choice !== undefined) {
      body.tool_choice = request.tool_choice
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      if (signal?.aborted) {
        resolve(false)
        return
      }

      let timer: NodeJS.Timeout | undefined
      const onAbort = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(false)
      }

      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
