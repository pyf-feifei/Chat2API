/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { ChatCompletionRequest, ChatCompletionResponse, ProxyContext } from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { qwenAiRequestGovernor } from '../qwenAiRequestGovernor'
import { KimiAdapter } from '../adapters/kimi'
import {
  QwenAiAdapter,
  QWEN_AI_STREAM_FAILURE_EVENT,
  type QwenAiOutputStream,
} from '../adapters/qwen-ai'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import {
  isAnthropicToolFormat,
  transformResponseToAnthropic,
  transformChunkToAnthropic
} from '../utils/toolFormatConverter'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'

const router = new Router({ prefix: '/v1/chat' })

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
}

function createClientAbortSignal(ctx: Context): AbortSignal {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', () => {
    if (!ctx.res.writableEnded) abort()
  })
  return controller.signal
}

function isQwenAiRiskControl(
  providerId: string | undefined,
  status: number | undefined,
  error: string | undefined,
  errorCode?: string,
  providerIsQwenAi = false,
): boolean {
  return Boolean(
    (providerId === 'qwen-ai' || providerIsQwenAi) &&
    (errorCode === 'qwen_ai_risk_control' || (
      (status === 403 || status === 429) &&
      error &&
      /qwen_ai_risk_control|FAIL_SYS_USER_VALIDATE|RGV587|bxpunish|risk-control|challenge|x5sec|baxia|punish/i.test(error)
    )),
  )
}

function streamFailureStatus(
  error: (Error & { status?: unknown }) | undefined,
  clientAborted = false,
): number {
  if (clientAborted) return 499
  if (typeof error?.status === 'number') return error.status
  if (isClientCancellationError(error)) return 499

  const message = error?.message || ''
  if (/timed out|timeout|idle for more than/i.test(message)) return 504
  return 502
}

function streamFailureCode(error: Error | undefined): string | undefined {
  const code = (error as (Error & { code?: unknown }) | undefined)?.code
  return typeof code === 'string' && code.trim() ? code : undefined
}

function streamFailureAccountFault(error: Error | undefined): boolean | undefined {
  const accountFault = (error as (Error & { accountFault?: unknown }) | undefined)?.accountFault
  return typeof accountFault === 'boolean' ? accountFault : undefined
}

function streamFailureHeaders(error: Error | undefined): Record<string, string> | undefined {
  const headers = (error as (Error & { headers?: unknown }) | undefined)?.headers
  return sanitizeForwardedErrorHeaders(headers)
}

function requestFailureLogLevel(status: number | undefined): 'debug' | 'warn' | 'error' {
  if (status === 499) return 'debug'
  if (status === 429) return 'warn'
  return 'error'
}

/**
 * Handle Chat Completions Request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let request: ChatCompletionRequest
  try {
    request = ctx.request.body as ChatCompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
        code: null,
      },
    }
    return
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const webSearchFromHeader = ctx.headers['x-web-search'] === 'true'
  const reasoningEffortFromHeader = ctx.headers['x-reasoning-effort'] as 'low' | 'medium' | 'high' | undefined
  const deepResearchFromHeader = ctx.headers['x-deep-research'] === 'true'

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort && !request.reasoning_effort) {
    request.reasoning_effort = requestAny.reasoningEffort
    console.log('[Chat] Reasoning effort set via reasoningEffort (camelCase):', requestAny.reasoningEffort)
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (webSearchFromHeader && request.web_search === undefined) {
    request.web_search = true
    console.log('[Chat] Web search enabled via X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (deepResearchFromHeader && request.deep_research === undefined) {
    request.deep_research = true
    console.log('[Chat] Deep research enabled via X-Deep-Research header')
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  const context: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP,
    signal: createClientAbortSignal(ctx),
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      request,
      account,
      provider,
      actualModel,
      context
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      if (result.accountFault !== false) {
        if (isQwenAiRiskControl(
          provider.id,
          result.status,
          result.error,
          result.errorCode,
          QwenAiAdapter.isQwenAiProvider(provider),
        )) {
          loadBalancer.markQwenAiRiskControl(account.id)
        } else if (result.status && result.status >= 400
          && result.status !== 429 && result.status !== 499) {
          loadBalancer.markAccountFailed(account.id)
        }
      }

      ctx.status = result.status || 500
      const safeErrorHeaders = sanitizeForwardedErrorHeaders(result.headers)
      if (safeErrorHeaders) {
        for (const [key, value] of Object.entries(safeErrorHeaders)) {
          ctx.set(key, value)
        }
      }
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      }

      const failureLogLevel = requestFailureLogLevel(result.status)
      storeManager.addLog(failureLogLevel, `${result.status === 499 ? 'Request cancelled' : 'Request failed'}: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
        errorCode: result.errorCode,
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      })
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: result.error,
        errorCode: result.errorCode,
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)

      return
    }

    const deferStreamOutcome = request.stream === true
      && Boolean(result.stream)
      && (
        KimiAdapter.isKimiProvider(provider)
        || QwenAiAdapter.isQwenAiProvider(provider)
      )

    if (!deferStreamOutcome) {
      loadBalancer.clearAccountFailure(account.id)
    }

    if (KimiAdapter.isKimiProvider(provider)) {
      if (result.providerSessionId) {
        ctx.set('X-Kimi-Conversation-Id', result.providerSessionId)
      }
      if (result.parentMessageId) {
        ctx.set('X-Kimi-Parent-Id', result.parentMessageId)
      }
    }

    if (!deferStreamOutcome) {
      proxyStatusManager.recordRequestSuccess(latency)

      storeManager.incrementAccountUsage(account.id)
    }

    storeManager.addLog('debug', deferStreamOutcome ? `Request stream started` : `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    const userInput = extractUserInput(request.messages)
    // Prepare response body for logging (only for non-stream requests)
    const responseBodyForLog = !request.stream && result.body
      ? JSON.stringify(result.body)
      : undefined

    // For streaming requests, we'll collect content and update the log later
    let logEntryId: string | undefined

    if (!request.stream) {
      // Non-streaming: record log with response body now
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      // Streaming: record log now, will update response body later
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        latency,
        isStream: true,
      })
      logEntryId = logEntry.id
    }

    if (!deferStreamOutcome) {
      storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id)
    }

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      // Create a wrapper stream to handle errors and collect content
      const wrapperStream = new PassThrough()

      // Collect stream content for logging (raw SSE output)
      let collectedContent = ''
      let streamOutcomeRecorded = !deferStreamOutcome

      const recordDeferredStreamOutcome = (success: boolean, error?: Error) => {
        if (!deferStreamOutcome || streamOutcomeRecorded) return
        streamOutcomeRecorded = true

        const completionLatency = Date.now() - startTime
        if (success) {
          loadBalancer.clearAccountFailure(account.id)
          proxyStatusManager.recordRequestSuccess(completionLatency)
          storeManager.incrementAccountUsage(account.id)
          storeManager.recordRequestInStats(true, completionLatency, request.model, provider.id, account.id)
          storeManager.addLog('debug', 'Stream response completed', {
            requestId,
            providerId: provider.id,
            accountId: account.id,
            model: request.model,
          })
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              latency: completionLatency,
              responseStatus: 200,
            })
          }
          return
        }

        const failureStatus = streamFailureStatus(
          error as (Error & { status?: unknown }) | undefined,
          context.signal?.aborted,
        )
        const failureCode = streamFailureCode(error)
        const qwenAiFailure = QwenAiAdapter.isQwenAiProvider(provider)
        if (qwenAiFailure) {
          qwenAiRequestGovernor.reportDeferredFailure(account.id, {
            success: false,
            status: failureStatus,
            headers: streamFailureHeaders(error),
            error: error?.message || 'Unknown Qwen AI stream error',
            errorCode: failureCode,
            retryable: false,
            accountFault: streamFailureAccountFault(error),
          })
        }
        proxyStatusManager.recordRequestFailure(completionLatency)
        if (failureStatus !== 499 && streamFailureAccountFault(error) !== false) {
          if (qwenAiFailure && isQwenAiRiskControl(
            provider.id,
            failureStatus,
            error?.message,
            failureCode,
            true,
          )) {
            loadBalancer.markQwenAiRiskControl(account.id)
          } else if (failureStatus !== 429) {
            loadBalancer.markAccountFailed(account.id)
          }
        }
        storeManager.recordRequestInStats(false, completionLatency, request.model, provider.id, account.id)
        const failureLogLevel = requestFailureLogLevel(failureStatus)
        storeManager.addLog(
          failureLogLevel,
          `${failureStatus === 499 ? 'Stream response cancelled' : 'Stream response failed'}: ${error?.message || 'Unknown stream error'}`,
          {
            requestId,
            providerId: provider.id,
            accountId: account.id,
            model: request.model,
            status: failureStatus,
            errorCode: failureCode,
          },
        )
        if (logEntryId) {
          storeManager.updateRequestLog(logEntryId, {
            status: 'error',
            statusCode: failureStatus,
            responseStatus: failureStatus,
            latency: completionLatency,
            errorMessage: error?.message || 'Stream failed',
            errorCode: failureCode,
            responseBody: collectedContent || undefined,
          })
        }
      }

      const qwenAiStream = QwenAiAdapter.isQwenAiProvider(provider)
        ? result.stream as QwenAiOutputStream
        : undefined
      if (qwenAiStream) {
        qwenAiStream.once(QWEN_AI_STREAM_FAILURE_EVENT, (error: Error) => {
          recordDeferredStreamOutcome(false, error)
        })
        if (qwenAiStream.qwenAiFailure) {
          recordDeferredStreamOutcome(false, qwenAiStream.qwenAiFailure)
        }
      }

      // Handle stream errors
      result.stream.once('error', (err: Error) => {
        const clientCancelled = context.signal?.aborted || isClientCancellationError(err)
        if (clientCancelled) {
          console.log('[Chat] Stream cancelled:', err.message)
        } else {
          console.error('[Chat] Stream error:', err.message)
        }
        recordDeferredStreamOutcome(false, err)

        if (clientCancelled) {
          wrapperStream.end()
          return
        }

        // Kimi's Connect handler deliberately withholds [DONE] when an
        // upstream trailer reports an error. Preserve that signal so clients
        // do not mistake a permission/auth failure for a successful answer.
        if (KimiAdapter.isKimiProvider(provider)) {
          wrapperStream.write(`data: ${JSON.stringify({
            error: {
              message: err.message,
              type: 'api_error',
            },
          })}\n\n`)
        } else {
          const errorEvent = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: actualModel,
            choices: [{
              index: 0,
              delta: {
                content: `\n\n[Error: ${err.message}]`,
              },
              finish_reason: 'stop',
            }],
          }

          wrapperStream.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
          wrapperStream.write('data: [DONE]\n\n')
        }
        wrapperStream.end()

        if (!deferStreamOutcome) {
          storeManager.addLog(requestFailureLogLevel(streamFailureStatus(err)), `Stream error: ${err.message}`, {
            requestId,
            providerId: provider.id,
            accountId: account.id,
            model: request.model,
          })
        }
      })

      // Check if stream is already in correct SSE format (from adapters like Kimi, GLM, DeepSeek)
      if (result.skipTransform) {
        // Stream is already formatted, pipe through wrapper and collect
        result.stream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        result.stream.pipe(wrapperStream, { end: false })

        // When source stream ends normally, update log and end wrapper
        result.stream.once('end', () => {
          const qwenAiFailure = qwenAiStream?.qwenAiFailure
          recordDeferredStreamOutcome(!qwenAiFailure, qwenAiFailure)
          // Update log with collected response
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              latency: Date.now() - startTime,
              responseBody: collectedContent || undefined,
            })
          }
          wrapperStream.end()
        })
      } else {
        // Need to transform the stream
        const transformStream = streamHandler.createTransformStream(
          actualModel,
          requestId,
          () => {
            storeManager.addLog('debug', `Stream response completed`, { requestId })
          }
        )

        // Collect from transform stream output
        transformStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        result.stream.pipe(transformStream)
        transformStream.pipe(wrapperStream, { end: false })

        transformStream.once('end', () => {
          // Update log with collected response
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              responseBody: collectedContent || undefined,
            })
          }
          wrapperStream.end()
        })
      }

      ctx.body = wrapperStream
    } else {
      ctx.set('Content-Type', 'application/json')

      if (result.body) {
        // Check if we need to transform to Anthropic format
        if (isAnthropicToolFormat(request.tool_format)) {
          ctx.body = transformResponseToAnthropic(result.body)
          console.log('[Chat] Transformed response to Anthropic tool format')
        } else {
          ctx.body = result.body
        }
      } else {
        ctx.body = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }
      }
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    const clientCancelled = context.signal?.aborted || isClientCancellationError(error)
    const errorStatus = clientCancelled ? 499 : 500

    ctx.status = errorStatus
    ctx.body = {
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    }

    storeManager.addLog(clientCancelled ? 'debug' : 'error', `${clientCancelled ? 'Request cancelled' : 'Request exception'}: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
      error: errorMessage,
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    })
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: errorStatus,
      method: 'POST',
      url: '/v1/chat/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      responseStatus: errorStatus,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage,
      errorStack,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
  }
})

export default router
