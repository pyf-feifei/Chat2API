/**
 * Proxy Service Module - Anthropic Messages API Compatible Route
 * Implements /v1/messages endpoint for Claude Code compatibility
 * Converts Anthropic Messages API <-> OpenAI Chat Completions format
 */
import Router from '@koa/router'
import type { Context } from 'koa'
import {
  ChatCompletionRequest,
  ChatCompletionTool,
  ChatMessage,
  type AccountSelection,
  type ProxyContext,
} from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { forwardWithAccountFailover, resolveAccountFailoverLimit } from '../accountFailover'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import { classifyChatRequest } from '../requestIntent'
import { proxyStatusManager } from '../status'
import { createAnthropicMessagesStream } from '../anthropic/stream'
import { anthropicToolResultToChatMessage } from '../anthropic/request'

const router = new Router({ prefix: '/v1' })

// ---- Anthropic Types ----

interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: string }
}

interface AnthropicImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
  is_error?: boolean
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

interface AnthropicMessagesRequest {
  model: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string | AnthropicContentBlock[]
  }>
  max_tokens: number
  system?: string | Array<{ type: 'text'; text: string; cache_control?: any }>
  stop_sequences?: string[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  metadata?: Record<string, any>
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, any>
    cache_control?: any
  }>
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none'
    name?: string
  }
  thinking?: {
    type?: string
    budget_tokens?: number
  }
}

// ---- Helpers ----

function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function getClientIP(ctx: Context): string {
  return (ctx.headers['x-real-ip'] as string) ||
    (ctx.headers['x-forwarded-for'] as string) ||
    ctx.ip ||
    'unknown'
}

function createClientAbortSignal(ctx: Context): AbortSignal {
  const controller = new AbortController()
  ctx.req.on('close', () => {
    if (!ctx.res.writableEnded) {
      controller.abort()
    }
  })
  return controller.signal
}

/**
 * Filter non-semantic billing headers from system prompt.
 * Claude Code prefixes system with x-anthropic-billing-header: line
 * containing cch=<hash> that regenerates every request, defeating
 * upstream prompt caching (cost 5-10x, latency impact).
 * See: 1rgs/claude-code-proxy#99, insightflo/chatgpt-codex-proxy#2
 */
function filterBillingHeaders(text: string): string {
  return text
    .replace(/^x-anthropic-billing-header:.*$/gm, '')
    .replace(/^\s*$/gm, '')
    .trim()
}

/**
 * Clean Gemini/DeepSeek schemas - remove unsupported fields
 * See: maxnowack/anthropic-proxy#1 (Google models reject uri format, empty object schemas)
 */
function cleanSchemaForProvider(schema: any, providerId: string): any {
  if (!schema || typeof schema !== 'object') return schema
  const cleaned = { ...schema }
  if (providerId === 'gemini' || providerId === 'google') {
    delete cleaned.additionalProperties
    delete cleaned.default
    if (cleaned.type === 'string' && cleaned.format) {
      const allowedFormats = ['enum', 'date-time']
      if (!allowedFormats.includes(cleaned.format)) {
        delete cleaned.format
      }
    }
  }
  if (cleaned.properties) {
    const props: Record<string, any> = {}
    for (const [key, value] of Object.entries(cleaned.properties)) {
      props[key] = cleanSchemaForProvider(value, providerId)
    }
    cleaned.properties = props
  }
  if (cleaned.items) {
    cleaned.items = cleanSchemaForProvider(cleaned.items, providerId)
  }
  return cleaned
}

/**
 * Convert Anthropic messages to OpenAI format
 */
function convertAnthropicToOpenAI(
  req: AnthropicMessagesRequest,
  providerId: string
): ChatCompletionRequest {
  const messages: ChatMessage[] = []

  if (req.system) {
    let systemText = ''
    if (typeof req.system === 'string') {
      systemText = req.system
    } else if (Array.isArray(req.system)) {
      systemText = req.system
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n\n')
    }
    systemText = filterBillingHeaders(systemText)
    if (systemText) {
      messages.push({ role: 'system', content: systemText })
    }
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: any[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          })
        }
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : (toolCalls.length > 0 ? null : ''),
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      messages.push(assistantMsg)
    } else if (msg.role === 'user') {
      const textParts: string[] = []
      const imageParts: any[] = []
      const toolResults: Array<{ tool_use_id: string; content: any; is_error?: boolean }> = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'image' && block.source?.type === 'base64') {
          imageParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
        } else if (block.type === 'tool_result') {
          toolResults.push({
            tool_use_id: block.tool_use_id,
            content: typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => b.text || '').join('\n')
                : JSON.stringify(block.content),
            is_error: block.is_error,
          })
        }
      }

      for (const result of toolResults) {
        messages.push(anthropicToolResultToChatMessage(result))
      }

      if (imageParts.length > 0) {
        const contentParts: any[] = []
        if (textParts.length > 0) {
          contentParts.push({ type: 'text', text: textParts.join('\n') })
        }
        contentParts.push(...imageParts)
        messages.push({ role: 'user', content: contentParts })
      } else if (textParts.length > 0) {
        messages.push({ role: 'user', content: textParts.join('\n') })
      }
    }
  }

  const tools: ChatCompletionTool[] | undefined = req.tools?.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: cleanSchemaForProvider(tool.input_schema || {}, providerId),
    },
  }))

  let toolChoice: any = undefined
  if (req.tool_choice) {
    switch (req.tool_choice.type) {
      case 'auto':
        toolChoice = 'auto'
        break
      case 'any':
        toolChoice = 'required'
        break
      case 'tool':
        if (req.tool_choice.name) {
          toolChoice = {
            type: 'function',
            function: { name: req.tool_choice.name },
          }
        }
        break
      case 'none':
        toolChoice = 'none'
        break
    }
  }

  let reasoningEffort: 'low' | 'medium' | 'high' | undefined
  if (req.thinking?.type === 'enabled' || req.thinking?.budget_tokens) {
    reasoningEffort = 'high'
  }

  const openaiReq: ChatCompletionRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream || false,
    stop: req.stop_sequences,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
    reasoning_effort: reasoningEffort,
  }

  return openaiReq
}

/**
 * Convert OpenAI non-streaming response to Anthropic format
 */
function convertOpenAIToAnthropic(openaiResp: any, model: string): any {
  const choice = openaiResp.choices?.[0]
  if (!choice) {
    return {
      id: generateMessageId(),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  const content: any[] = []
  const message = choice.message

  if (message.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: message.reasoning_content,
    })
  }

  if (message.content) {
    content.push({
      type: 'text',
      text: message.content,
    })
  }

  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedInput: Record<string, any> = {}
      try {
        parsedInput = JSON.parse(tc.function?.arguments || '{}')
      } catch {
        parsedInput = { raw: tc.function?.arguments || '' }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || '',
        input: parsedInput,
      })
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  let stopReason = 'end_turn'
  switch (choice.finish_reason) {
    case 'tool_calls':
      stopReason = 'tool_use'
      break
    case 'length':
      stopReason = 'max_tokens'
      break
    case 'stop':
    case null:
    case undefined:
      stopReason = 'end_turn'
      break
    default:
      stopReason = 'end_turn'
  }

  return {
    id: openaiResp.id || generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResp.model || model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: openaiResp.usage?.prompt_tokens_details?.cached_tokens || 0,
      cache_read_input_tokens: 0,
    },
  }
}

// ---- Main Route ----

router.post('/messages', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let anthropicReq: AnthropicMessagesRequest
  try {
    anthropicReq = ctx.request.body as AnthropicMessagesRequest
  } catch {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Invalid request body',
      },
    }
    return
  }

  if (!anthropicReq || !anthropicReq.model) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages: missing required field: model',
      },
    }
    return
  }

  if (!anthropicReq.messages || !Array.isArray(anthropicReq.messages) || anthropicReq.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages: missing required field: messages',
      },
    }
    return
  }

  if (!anthropicReq.max_tokens || anthropicReq.max_tokens < 1) {
    ctx.status = 400
    ctx.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages: missing required field: max_tokens',
      },
    }
    return
  }

  const config = storeManager.getConfig()
  const mappedPreferredProviderId = modelMapper.getPreferredProvider(anthropicReq.model)
  const mappedPreferredAccountId = modelMapper.getPreferredAccount(anthropicReq.model)

  const initialSelection = loadBalancer.selectAccount(
    anthropicReq.model,
    config.loadBalanceStrategy,
    mappedPreferredProviderId,
    mappedPreferredAccountId,
    new Set<string>(),
  )

  if (!initialSelection) {
    ctx.status = 503
    ctx.body = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `No available account for model: ${anthropicReq.model}`,
      },
    }
    return
  }

  const clientSignal = createClientAbortSignal(ctx)

  const maxFailovers = resolveAccountFailoverLimit({
    configuredMaxFailovers: config.retryCount,
    qwenAiProvider: false,
    activeAccountCount: 0,
  })

  const openaiReq = convertAnthropicToOpenAI(anthropicReq, initialSelection.provider.id)
  openaiReq.signal = clientSignal

  const requestIntent = classifyChatRequest(openaiReq)
  console.info('[Anthropic] request-intent', JSON.stringify({
    requestId,
    intent: requestIntent.intent,
    model: anthropicReq.model,
    messageCount: openaiReq.messages.length,
    stream: anthropicReq.stream,
  }))

  const createProxyContext = (
    selection: AccountSelection,
  ): ProxyContext => ({
    requestId,
    providerId: selection.provider.id,
    accountId: selection.account.id,
    model: openaiReq.model,
    actualModel: selection.actualModel,
    startTime,
    isStream: openaiReq.stream || false,
    clientIP,
    signal: clientSignal,
    requestIntent: requestIntent.intent,
  })

  const runWithAccountFailover = () => forwardWithAccountFailover({
    initialSelection,
    maxFailovers,
    signal: clientSignal,
    forward: async ({ selection }) => {
      const attemptContext = createProxyContext(selection)
      return requestForwarder.forwardChatCompletion(
        openaiReq,
        selection.account,
        selection.provider,
        selection.actualModel,
        attemptContext,
      )
    },
    selectNext: excludedAccountIds => loadBalancer.selectAccount(
      openaiReq.model,
      config.loadBalanceStrategy,
      mappedPreferredProviderId,
      mappedPreferredAccountId,
      excludedAccountIds,
    ),
    onFailedAttempt: ({ selection, attempt }, result) => {
      if (result.accountFault !== false) {
        loadBalancer.markAccountFailed(selection.account.id)
      }
      storeManager.addLog('warn', 'Anthropic: Retrying with another account', {
        requestId,
        providerId: selection.provider.id,
        accountId: selection.account.id,
        model: openaiReq.model,
        data: { attempt },
      })
    },
  })

  let account = initialSelection.account
  let provider = initialSelection.provider
  let actualModel = initialSelection.actualModel
  proxyStatusManager.recordRequestStart(anthropicReq.model, provider.id, account.id)
  let outcomeRecorded = false
  const recordOutcome = (success: boolean, error?: Error) => {
    if (outcomeRecorded) return
    outcomeRecorded = true
    const latency = Date.now() - startTime
    if (success) {
      loadBalancer.clearAccountFailure(account.id)
      proxyStatusManager.recordRequestSuccess(latency)
      storeManager.incrementAccountUsage(account.id)
    } else {
      proxyStatusManager.recordRequestFailure(latency)
    }
    storeManager.recordRequestInStats(success, latency, anthropicReq.model, provider.id, account.id)
    storeManager.addLog(success ? 'info' : 'error', success
      ? 'Anthropic request completed'
      : `Anthropic request failed: ${error?.message || 'Unknown stream error'}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: anthropicReq.model,
      actualModel,
      latency,
      isStream: anthropicReq.stream || false,
      errorCode: (error as (Error & { code?: string }) | undefined)?.code,
    })
  }

  try {
    const outcome = await runWithAccountFailover()
    account = outcome.selection.account
    provider = outcome.selection.provider
    actualModel = outcome.selection.actualModel
    const result = outcome.result
    const latency = Date.now() - startTime

    if (!result.success) {
      storeManager.addLog('error', `Anthropic request failed: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: openaiReq.model,
        latency,
      })
      ctx.status = result.status || 500
      ctx.body = {
        type: 'error',
        error: {
          type: 'api_error',
          message: result.error || 'Request failed',
        },
      }
      recordOutcome(false, new Error(result.error || 'Request failed'))
      return
    }

    if (anthropicReq.stream) {
      if (!result.stream) {
        ctx.status = 502
        ctx.body = {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Upstream returned no stream for a streaming Messages request.',
          },
        }
        recordOutcome(false, new Error('Upstream returned no stream for a streaming Messages request.'))
        return
      }

      const messageId = generateMessageId()
      const transStream = createAnthropicMessagesStream(result.stream, {
        messageId,
        model: actualModel,
        onSuccess: () => recordOutcome(true),
        onFailure: error => recordOutcome(false, error),
      })

      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')
      ctx.body = transStream
    } else {
      const anthropicResp = convertOpenAIToAnthropic(result.body, actualModel)
      ctx.set('Content-Type', 'application/json')
      ctx.body = anthropicResp
      recordOutcome(true)
    }
  } catch (error: any) {
    const latency = Date.now() - startTime
    const errorMessage = error?.message || 'Internal error'
    storeManager.addLog('error', `Anthropic request error: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: anthropicReq.model,
      latency,
    })
    ctx.status = 500
    ctx.body = {
      type: 'error',
      error: {
        type: 'api_error',
        message: errorMessage,
      },
    }
    recordOutcome(false, error instanceof Error ? error : new Error(errorMessage))
  }
})

export default router
