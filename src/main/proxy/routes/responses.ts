import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import Router from '@koa/router'
import type { Context, Next } from 'koa'
import {
  requestForwarder,
  shouldDeferQwenAiManagedStreamCommit,
} from '../forwarder'
import { loadBalancer } from '../loadbalancer'
import { forwardWithAccountFailover, resolveAccountFailoverLimit } from '../accountFailover'
import { createQwenAiBusyFailoverStopRule } from '../qwenBusyFailover'
import {
  combineQwenAiFailoverStopRules,
  createQwenAiContentFailoverStopRule,
} from '../qwenContentFailover'
import { slimQwenAiReplayImages, qwenAiImageSlimModeFromEnv, shouldSlimQwenAiAttemptImages } from '../replayImageSlimming'
import { createDeferredQwenAiFailoverStream } from '../qwenAiDeferredStream'
import { qwenAiRequestGovernor } from '../qwenAiRequestGovernor'
import {
  QwenAiAdapter,
  QWEN_AI_STREAM_FAILURE_EVENT,
  type QwenAiOutputStream,
} from '../adapters/qwen-ai'
import { modelMapper } from '../modelMapper'
import { proxyStatusManager } from '../status'
import { streamHandler } from '../stream'
import type {
  AccountSelection,
  ChatMessage,
  ProxyContext,
  QwenAiEgressRecoveryState,
  QwenAiLogicalRecoveryState,
} from '../types'
import { storeManager } from '../../store/store'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'
import { SseKeepAliveStream } from '../utils/sseKeepAlive'
import {
  chatCompletionToResponse,
  responseOutputToChatMessages,
  responseOutputToSidecarItems,
  responsesRequestToChatCompletion,
  ResponsesCompatibilityError,
  type ResponseCreateRequest,
} from '../responses/compat'
import { responsesConversationStore } from '../responses/store'
import { responsesSessionLock } from '../responses/sessionLock'
import { detectResponsesToolLoop, responsesToolLoopCorrectionMessage } from '../responses/toolLoopGuard'
import { createResponsesStreamTransform } from '../responses/stream'
import {
  createAssistantOutputBoundaryStream,
  guardAssistantOutputCompletion,
} from '../toolCalling/assistantOutputBoundary'
import { classifyChatRequest } from '../requestIntent'
import { estimateQwenAiRequestInputTokens } from '../qwenAiCompactionBoundary'
import {
  createQwenAiSessionRequestFingerprint,
  createQwenAiTranscriptHash,
  createQwenAiDeltaHash,
  createQwenAiChainKey,
  qwenAiStickyChainHeadFromEnv,
  resolveQwenAiSessionBinding,
  isQwenAiPoisonedChatErrorCode,
  type QwenAiSessionBridge,
  type QwenAiSessionBinding,
  type QwenAiSessionState,
} from '../qwenAiSessionBridge'
import { qwenAiStickyRegistry, type QwenAiStickyChainClaim } from '../qwenAiStickyRegistry'
import { isQwenAiStickySessionMode } from '../../store/types'
import {
  getTrailingQwenAiToolResultBatch,
  qwenAiToolCallSessionStore,
  type QwenAiToolCallSessionClaim,
} from '../qwenAiToolCallSessionStore'
import {
  createResponseImageResolver,
  ResponseImageResolutionError,
} from '../responses/image'
import {
  isQwenAiAccountFault as classifyQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../qwenAiAccountPolicy'

function isQwenAiAccountFault(value: Parameters<typeof classifyQwenAiAccountFault>[0] | undefined): boolean {
  return classifyQwenAiAccountFault(value)
}

const router = new Router({ prefix: '/v1' })

function createResponseId(): string {
  return `resp_${Date.now().toString(36)}${randomUUID().replace(/-/g, '')}`
}

function createClientAbortController(ctx: Context): {
  controller: AbortController
  cleanup: () => void
} {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  const onClose = () => {
    if (!ctx.res.writableEnded) abort()
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', onClose)
  return {
    controller,
    cleanup: () => {
      ctx.req.removeListener('aborted', abort)
      ctx.res.removeListener('close', onClose)
    },
  }
}

function clientIp(ctx: Context): string {
  const forwarded = ctx.headers['x-forwarded-for']
  return (ctx.headers['x-real-ip'] as string | undefined)
    ?? (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?? ctx.ip
    ?? 'unknown'
}

function writeInvalidRequest(
  ctx: Context,
  message: string,
  param: string | null,
  code: string | null,
): void {
  ctx.status = 400
  ctx.body = {
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code,
    },
  }
}

function destroyStream(stream: NodeJS.ReadableStream | undefined, error?: Error): void {
  const destroy = (stream as Readable | undefined)?.destroy
  if (typeof destroy === 'function' && !(stream as Readable).destroyed) {
    destroy.call(stream, error)
  }
}

function streamFailureStatus(
  error: (Error & { status?: unknown }) | undefined,
  clientAborted = false,
): number {
  if (clientAborted || isClientCancellationError(error)) return 499
  if (typeof error?.status === 'number') return error.status
  if (/timed out|timeout|idle for more than/i.test(error?.message || '')) return 504
  return 502
}

function streamFailureCode(error: Error | undefined): string | undefined {
  const code = (error as (Error & { code?: unknown }) | undefined)?.code
  return typeof code === 'string' && code.trim() ? code : undefined
}

function streamFailureAccountFault(
  error: Error | undefined,
  status?: number,
): boolean | undefined {
  if (status === 499) return false
  const accountFault = (error as (Error & { accountFault?: unknown }) | undefined)?.accountFault
  return typeof accountFault === 'boolean' ? accountFault : undefined
}

function streamFailureRetryScope(
  error: Error | undefined,
  status?: number,
): 'next-account' | undefined {
  if (status === 499) return undefined
  const retryScope = (error as (Error & { retryScope?: unknown }) | undefined)?.retryScope
  return retryScope === 'next-account' ? retryScope : undefined
}

function streamFailureHeaders(error: Error | undefined): Record<string, string> | undefined {
  const headers = (error as (Error & { headers?: unknown }) | undefined)?.headers
  return sanitizeForwardedErrorHeaders(headers)
}

function isResponseToolResultInputItem(value: unknown): value is Record<string, any> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      (value as Record<string, unknown>).type === 'function_call_output'
      || (value as Record<string, unknown>).type === 'custom_tool_call_output'
    )
}

function inputContainsOnlyToolResults(input: ResponseCreateRequest['input'] | undefined): boolean {
  return Array.isArray(input)
    && input.length > 0
    && input.every(isResponseToolResultInputItem)
}

function hasUsableQwenAiSessionBinding(
  binding: QwenAiSessionBinding | undefined,
  requestFingerprint: string | undefined,
  requestModel: string,
): binding is QwenAiSessionBinding {
  return Boolean(
    binding
    && requestFingerprint
    && binding.requestFingerprint === requestFingerprint
    && binding.requestedModel === requestModel
    && binding.providerId.trim()
    && binding.accountId.trim()
    && binding.actualModel.trim()
    && binding.chatId.trim()
    && binding.parentId.trim(),
  )
}

function isQwenAiSessionStaleErrorCode(errorCode: unknown): boolean {
  return String(errorCode || '').trim().toLowerCase() === 'qwen_ai_session_stale'
}

function isQwenAiContinuationRejectedErrorCode(errorCode: unknown): boolean {
  return String(errorCode || '').trim().toLowerCase() === 'qwen_ai_continuation_rejected'
}

function isQwenAiChatInProgressErrorCode(errorCode: unknown): boolean {
  return String(errorCode || '').trim().toUpperCase() === 'CHAT_IN_PROGRESS'
}

// isQwenAiPoisonedChatErrorCode lives in qwenAiSessionBridge (imported above):
// error codes bound to the specific retained upstream chatId (internal_error,
// managed_tool_result_wrapper_leak, qwen_ai_upstream_http_rejection) mean the
// chat itself is poisoned — a reconnect re-binding to it loops the identical
// verdict. clearsPreviousBinding releases the chain so the next request mints
// a fresh chain/chat instead of re-attaching to the dead branch.

function responseOutputToolCallIds(output: Array<Record<string, any>>): string[] {
  const ids = new Set<string>()
  for (const item of output) {
    if (
      (item?.type === 'function_call' || item?.type === 'custom_tool_call')
      && typeof item.call_id === 'string'
      && item.call_id.trim()
    ) {
      ids.add(item.call_id.trim())
    }
  }
  return Array.from(ids)
}

async function responsesLineageLockMiddleware(ctx: Context, next: Next): Promise<void> {
  const request = ctx.request.body as ResponseCreateRequest
  const previousResponseId = typeof request?.previous_response_id === 'string'
    ? request.previous_response_id.trim()
    : ''
  if (!previousResponseId) {
    await next()
    return
  }

  const waitAbort = new AbortController()
  const abortWait = () => waitAbort.abort()
  ctx.req.once('aborted', abortWait)
  ctx.res.once('close', abortWait)
  let release: (() => void) | undefined
  try {
    release = await responsesSessionLock.acquire(previousResponseId, waitAbort.signal)
  } catch (error) {
    ctx.status = 499
    ctx.body = {
      error: {
        message: error instanceof Error ? error.message : 'Responses session lock wait was aborted.',
        type: 'api_error',
        param: 'previous_response_id',
        code: 'responses_session_lock_aborted',
      },
    }
    return
  } finally {
    ctx.req.removeListener('aborted', abortWait)
    ctx.res.removeListener('close', abortWait)
  }

  let released = false
  const releaseOnce = () => {
    if (released) return
    released = true
    release?.()
  }
  try {
    await next()
  } catch (error) {
    releaseOnce()
    throw error
  }

  const body = ctx.body as (NodeJS.ReadableStream & {
    readableEnded?: boolean
    destroyed?: boolean
  }) | undefined
  if (!body || typeof body.once !== 'function' || body.readableEnded || body.destroyed) {
    releaseOnce()
    return
  }
  body.once('end', releaseOnce)
  body.once('close', releaseOnce)
  body.once('error', releaseOnce)
  ctx.res.once('finish', releaseOnce)
  ctx.res.once('close', releaseOnce)
}

router.post('/responses', responsesLineageLockMiddleware, async (ctx: Context) => {
  const startedAt = Date.now()
  const createdAt = Math.floor(startedAt / 1000)
  const responseId = createResponseId()
  const abort = createClientAbortController(ctx)
  const request = ctx.request.body as ResponseCreateRequest
  const config = storeManager.getConfig()

  const responseStateEnabled = request?.store !== false
  const responseInputItems = Array.isArray(request?.input) ? request.input : []
  const toolResultItems = responseInputItems.filter(isResponseToolResultInputItem)
  if (toolResultItems.length > 0) {
    console.info('[Responses] tool-result ingress', JSON.stringify({
      requestId: responseId,
      toolResultCount: toolResultItems.length,
      isErrorTrueCount: toolResultItems.filter(item => item.is_error === true).length,
      isErrorFalseCount: toolResultItems.filter(item => item.is_error === false).length,
      isErrorMissingCount: toolResultItems.filter(item => typeof item.is_error !== 'boolean').length,
    }))
  }

  const previousResponseId = typeof request?.previous_response_id === 'string'
    ? request.previous_response_id.trim() || undefined
    : undefined
  let previousMessages: ChatMessage[] = []
  let previousSidecarItems = [] as import('../responses/compat').ResponsesSidecarItem[]
  let previousQwenAiSessionBinding: QwenAiSessionBinding | undefined
  if (previousResponseId) {
    const stored = responsesConversationStore.getConversation(previousResponseId)
    if (!stored) {
      abort.cleanup()
      writeInvalidRequest(
        ctx,
        `Previous response context is unavailable: ${previousResponseId}`,
        'previous_response_id',
        'response_context_unavailable',
      )
      return
    }
    previousMessages = stored.messages
    previousSidecarItems = stored.sidecarItems ?? []
    previousQwenAiSessionBinding = stored.qwenAiSessionBinding
  }

  let translated: ReturnType<typeof responsesRequestToChatCompletion>
  try {
    translated = responsesRequestToChatCompletion(request, previousMessages)
  } catch (error) {
    abort.cleanup()
    if (error instanceof ResponsesCompatibilityError) {
      writeInvalidRequest(ctx, error.message, error.param, error.code)
      return
    }
    writeInvalidRequest(ctx, error instanceof Error ? error.message : 'Invalid request body', null, null)
    return
  }

  const chatRequest = {
    ...translated.chatRequest,
    signal: abort.controller.signal,
  }
  const translatedToolResults = chatRequest.messages.filter(message => message.role === 'tool')
  if (translatedToolResults.length > 0) {
    console.info('[Responses] tool-result translated', JSON.stringify({
      requestId: responseId,
      toolResultCount: translatedToolResults.length,
      isErrorTrueCount: translatedToolResults.filter(message => message.is_error === true).length,
      isErrorFalseCount: translatedToolResults.filter(message => message.is_error === false).length,
      isErrorMissingCount: translatedToolResults.filter(message => typeof message.is_error !== 'boolean').length,
    }))
  }
  const requestIntent = classifyChatRequest(chatRequest)
  if (/^1|true|on$/i.test(String(process.env.CHAT2API_RESPONSES_DEBUG_REQUEST ?? '').trim())) {
    // Raw client-visible tool types: codex switches its shell tool to the
    // `local_shell` Responses type for gpt-5-family model names, and any type
    // the translator drops silently zeroes the managed tool path.
    console.info('[Responses] raw request tools', JSON.stringify({
      requestId: responseId,
      tools: (request?.tools ?? []).map((tool: any) => ({ type: tool?.type, name: tool?.name ?? tool?.function?.name })),
      tool_choice: request?.tool_choice ?? null,
      instructionsChars: typeof request?.instructions === 'string' ? request.instructions.length : 0,
    }))
  }
  const estimatedInputTokens = estimateQwenAiRequestInputTokens(chatRequest)
  const messageBytes = Buffer.byteLength(JSON.stringify(chatRequest.messages), 'utf8')
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(chatRequest.tools ?? []), 'utf8')
  console.info('[Responses] request-intent', JSON.stringify({
    requestId: responseId,
    intent: requestIntent.intent,
    reason: requestIntent.reason,
    signals: requestIntent.signals,
    messageCount: requestIntent.messageCount,
    toolCount: requestIntent.toolCount,
    toolResultCount: requestIntent.toolResultCount,
    textChars: requestIntent.textChars,
    estimatedInputTokens,
    messageBytes,
    toolSchemaBytes,
    usageEstimator: 'qwen_conservative_v1',
  }))

  const toolLoop = requestIntent.intent === 'normal'
    ? detectResponsesToolLoop(chatRequest.messages)
    : undefined
  if (toolLoop && !toolLoop.correctionAlreadyIssued) {
    // First detection: guide instead of killing the turn. A repeated
    // identical call with an identical result is a stalled model, not a bad
    // request 鈥?inject a corrective note into this turn's delta so the model
    // is told to switch tools or finish, and let the request proceed. The
    // note persists in the stored transcript; if the loop continues past it,
    // the next detection escalates to the 422 below.
    const correction = {
      role: 'user' as const,
      content: responsesToolLoopCorrectionMessage(toolLoop),
    }
    chatRequest.messages = [...chatRequest.messages, correction]
    translated.conversationMessages.push(correction)
    storeManager.addLog('warn', 'Responses tool-call loop detected; injected corrective turn instead of failing', {
      requestId: responseId,
      model: chatRequest.model,
      errorCode: 'repeated_tool_call_loop',
      data: toolLoop,
    })
    console.info('[Responses] tool-loop correction injected', JSON.stringify({
      requestId: responseId,
      toolName: toolLoop.toolName,
      repeatCount: toolLoop.repeatCount,
    }))
  } else if (toolLoop) {
    abort.cleanup()
    storeManager.addLog('warn', 'Stopped a Responses tool-call loop with no observable progress', {
      requestId: responseId,
      model: chatRequest.model,
      errorCode: 'repeated_tool_call_loop',
      data: toolLoop,
    })
    ctx.status = 422
    ctx.body = {
      error: {
        message: `Repeated tool call loop detected for ${toolLoop.toolName} after ${toolLoop.repeatCount} unchanged results.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'repeated_tool_call_loop',
      },
    }
    return
  }

  const qwenAiToolCallSessionEnabled = config.qwenAiSessionMode !== 'legacy'
  const managedToolResponsesRequest = responseStateEnabled
    && qwenAiToolCallSessionEnabled
    && requestIntent.intent !== 'context_compaction'
    && Boolean(chatRequest.tools?.length)
    && chatRequest.tool_choice !== 'none'
  // Sticky chains need the fingerprint even when store:false gates the
  // managed-tool flag — the tool contract must still be verified before a
  // continuation is allowed.
  const qwenAiRequestFingerprint = (managedToolResponsesRequest || (
    isQwenAiStickySessionMode(config.qwenAiSessionMode)
      && qwenAiToolCallSessionEnabled
      && requestIntent.intent !== 'context_compaction'
      && Boolean(chatRequest.tools?.length)
      && chatRequest.tool_choice !== 'none'
  ))
    ? createQwenAiSessionRequestFingerprint(chatRequest)
    : undefined
  let qwenAiContinuationInputMessages = translated.conversationMessages.slice(previousMessages.length)
  // A Responses function_call_output with a file/image is translated into a
  // normal tool message followed by a synthetic user attachment message. The
  // attachment is safe to send as part of the delta because raw input below
  // contains only tool outputs, but it is not itself a tool-result message
  // for the strict call-id batch validator.
  const rawInputIsOnlyToolResults = inputContainsOnlyToolResults(request?.input)
  const previousQwenAiToolResultBatch = rawInputIsOnlyToolResults
    ? getTrailingQwenAiToolResultBatch([
      ...previousMessages,
      ...qwenAiContinuationInputMessages,
    ])
    : undefined
  const fullHistoryQwenAiToolResultBatch = managedToolResponsesRequest
    ? getTrailingQwenAiToolResultBatch(chatRequest.messages)
    : undefined
  const qwenAiToolCallClaimResult = fullHistoryQwenAiToolResultBatch
    ? qwenAiToolCallSessionStore.claim(fullHistoryQwenAiToolResultBatch.toolCallIds)
    : { status: 'missing' as const }
  if (qwenAiToolCallClaimResult.status === 'busy') {
    abort.cleanup()
    ctx.set('Retry-After', String(Math.max(1, Math.ceil(qwenAiToolCallClaimResult.retryAfterMs / 1000))))
    ctx.status = 429
    ctx.body = {
      error: {
        message: 'The Qwen tool-call continuation is already in progress.',
        type: 'api_error',
        param: null,
        code: 'CHAT_IN_PROGRESS',
      },
    }
    return
  }
  const cachedQwenAiSessionBinding = qwenAiToolCallClaimResult.status === 'claimed'
    ? qwenAiToolCallClaimResult.binding
    : undefined
  const qwenAiToolCallClaim: QwenAiToolCallSessionClaim | undefined =
    qwenAiToolCallClaimResult.status === 'claimed'
      ? qwenAiToolCallClaimResult.claim
      : undefined
  let qwenAiToolCallClaimFinalized = false
  const finalizeQwenAiToolCallClaim = (
    disposition: 'consume' | 'release',
    reason: string,
  ) => {
    if (!qwenAiToolCallClaim || qwenAiToolCallClaimFinalized) return
    qwenAiToolCallClaimFinalized = true
    const applied = disposition === 'consume'
      ? qwenAiToolCallSessionStore.consume(qwenAiToolCallClaim)
      : qwenAiToolCallSessionStore.release(qwenAiToolCallClaim)
    storeManager.addLog('debug', `${disposition === 'consume' ? 'Consumed' : 'Released'} Qwen tool-call session claim`, {
      requestId: responseId,
      providerId: cachedQwenAiSessionBinding?.providerId,
      accountId: cachedQwenAiSessionBinding?.accountId,
      model: chatRequest.model,
      data: { reason, applied },
    })
  }
  const consumeQwenAiToolCallClaim = (reason: string) => {
    finalizeQwenAiToolCallClaim('consume', reason)
  }
  const releaseQwenAiToolCallClaim = (reason: string) => {
    finalizeQwenAiToolCallClaim('release', reason)
  }
  const finalizeFailedQwenAiToolCallClaim = (
    errorCode: unknown,
    accountFault: boolean | undefined,
    retryScope: 'next-account' | undefined,
    reason: string,
  ) => {
    if (isQwenAiChatInProgressErrorCode(errorCode)) {
      releaseQwenAiToolCallClaim(`${reason}_chat_in_progress`)
      return
    }
    if (
      isQwenAiSessionStaleErrorCode(errorCode)
      || isQwenAiContinuationRejectedErrorCode(errorCode)
      || (accountFault === true && retryScope === 'next-account')
    ) {
      consumeQwenAiToolCallClaim(reason)
      return
    }
    releaseQwenAiToolCallClaim(reason)
  }
  let previousQwenAiSessionBindingCleared = false
  const clearPreviousQwenAiSessionBinding = (reason: string) => {
    if (!previousResponseId || !previousQwenAiSessionBinding || previousQwenAiSessionBindingCleared) {
      return
    }
    previousQwenAiSessionBindingCleared = true
    if (previousQwenAiSessionBinding.lineageKey) {
      qwenAiStickyRegistry.release(previousQwenAiSessionBinding.lineageKey)
    }
    responsesConversationStore.clearQwenAiSessionBinding(previousResponseId)
    storeManager.addLog('debug', 'Cleared unusable Qwen Responses session binding', {
      requestId: responseId,
      providerId: previousQwenAiSessionBinding.providerId,
      accountId: previousQwenAiSessionBinding.accountId,
      model: chatRequest.model,
      data: { reason },
    })
  }
  let qwenAiContinuationBinding: QwenAiSessionBinding | undefined
  const clearQwenAiContinuationState = (reason: string) => {
    clearPreviousQwenAiSessionBinding(reason)
    consumeQwenAiToolCallClaim(reason)
  }

  if (previousQwenAiSessionBinding && responseStateEnabled) {
    const bindingAccount = storeManager.getAccountById(previousQwenAiSessionBinding.accountId)
    const bindingProvider = storeManager.getProviderById(previousQwenAiSessionBinding.providerId)
    const bindingOwnershipMatches = bindingAccount?.providerId === bindingProvider?.id
      && bindingProvider !== undefined
      && QwenAiAdapter.isQwenAiProvider(bindingProvider)
    const continuationCompatible = managedToolResponsesRequest
      && rawInputIsOnlyToolResults
      && previousQwenAiToolResultBatch !== undefined
      && bindingOwnershipMatches
      && hasUsableQwenAiSessionBinding(
        previousQwenAiSessionBinding,
        qwenAiRequestFingerprint,
        chatRequest.model,
      )
    if (continuationCompatible) {
      qwenAiContinuationBinding = previousQwenAiSessionBinding
      qwenAiContinuationInputMessages = previousQwenAiToolResultBatch!.messages
    } else {
      clearPreviousQwenAiSessionBinding('continuation_incompatible')
    }
  }

  if (!qwenAiContinuationBinding && cachedQwenAiSessionBinding) {
    const bindingAccount = storeManager.getAccountById(cachedQwenAiSessionBinding.accountId)
    const bindingProvider = storeManager.getProviderById(cachedQwenAiSessionBinding.providerId)
    const bindingOwnershipMatches = bindingAccount?.providerId === bindingProvider?.id
      && bindingProvider !== undefined
      && QwenAiAdapter.isQwenAiProvider(bindingProvider)
    if (
      bindingOwnershipMatches
      && hasUsableQwenAiSessionBinding(
        cachedQwenAiSessionBinding,
        qwenAiRequestFingerprint,
        chatRequest.model,
      )
    ) {
      qwenAiContinuationBinding = cachedQwenAiSessionBinding
      qwenAiContinuationInputMessages = fullHistoryQwenAiToolResultBatch!.messages
    } else {
      consumeQwenAiToolCallClaim('continuation_incompatible')
    }
  }

  // --- Sticky session mode -------------------------------------------------
  // Beyond pure tool-result turns, any delta (new user text, tool results,
  // attachments) can be appended to the retained upstream chat, provided the
  // client-sent history still prefixes the stored transcript and the tool
  // contract fingerprint is unchanged.
  const stickySessionEnabled = isQwenAiStickySessionMode(config.qwenAiSessionMode)
    && qwenAiToolCallSessionEnabled
  let qwenAiStickyResumeTicket: QwenAiSessionBinding['appendedTurn'] | undefined
  if (
    stickySessionEnabled
    && !qwenAiContinuationBinding
    && previousQwenAiSessionBinding
    && responseStateEnabled
    && previousResponseId
    && managedToolResponsesRequest
  ) {
    const binding = previousQwenAiSessionBinding
    const bindingAccount = storeManager.getAccountById(binding.accountId)
    const bindingProvider = storeManager.getProviderById(binding.providerId)
    const bindingOwnershipMatches = bindingAccount?.providerId === bindingProvider?.id
      && bindingProvider !== undefined
      && QwenAiAdapter.isQwenAiProvider(bindingProvider)

    // Delta = messages the client added on top of the stored transcript.
    const deltaMessages = translated.conversationMessages.slice(previousMessages.length)
    const prefixMatches = previousMessages.length === 0
      ? chatRequest.messages.length === 0
      : Boolean(
          binding.transcriptHash
          && createQwenAiTranscriptHash(previousMessages)
            === binding.transcriptHash,
        )
    // Cheap sanity check the cheap way first: the request's own history must
    // actually contain the stored prefix (same length or longer, same head).
    const historyExtendsStored = chatRequest.messages.length >= previousMessages.length
      && (
        previousMessages.length === 0
        || createQwenAiTranscriptHash(chatRequest.messages.slice(0, previousMessages.length))
          === binding.transcriptHash
      )
    const deltaNonEmpty = deltaMessages.length > 0

    if (
      bindingOwnershipMatches
      && prefixMatches
      && historyExtendsStored
      && deltaNonEmpty
      && hasUsableQwenAiSessionBinding(
        binding,
        qwenAiRequestFingerprint,
        chatRequest.model,
      )
    ) {
      const deltaHash = createQwenAiDeltaHash(deltaMessages)
      const priorTicket = binding.appendedTurn
      if (
        priorTicket
        && priorTicket.prevResponseId === previousResponseId
        && priorTicket.deltaHash === deltaHash
      ) {
        // Idempotent retry: the delta was already appended upstream. Signal
        // the forwarder to resume the existing generation instead of pushing
        // the user message again.
        qwenAiStickyResumeTicket = priorTicket
        qwenAiContinuationBinding = binding
        qwenAiContinuationInputMessages = []
      } else if (
        priorTicket
        && priorTicket.prevResponseId === previousResponseId
        && priorTicket.deltaHash !== deltaHash
      ) {
        // Same prev_response_id but a different delta = client rewrote the
        // turn. Treat as history rewrite → full replay fallback.
        clearPreviousQwenAiSessionBinding('sticky_delta_mismatch')
      } else {
        qwenAiContinuationBinding = binding
        qwenAiContinuationInputMessages = deltaMessages
        console.info('[Responses] Qwen sticky session continuation candidate', JSON.stringify({
          requestId: responseId,
          providerId: binding.providerId,
          accountId: binding.accountId,
          chatId: binding.chatId,
          deltaMessageCount: deltaMessages.length,
          turnCount: binding.turnCount ?? 0,
        }))
      }
    } else if (bindingOwnershipMatches && deltaNonEmpty && !prefixMatches) {
      // Client history diverged from what was stored — the delta cannot be
      // appended without losing context.
      clearPreviousQwenAiSessionBinding('sticky_transcript_prefix_mismatch')
    }
  }
  // -------------------------------------------------------------------------

  // --- Sticky chain mode (store:false clients like codex) --------------------
  // Codex never sends previous_response_id and always sets store:false, so
  // the conversation store is bypassed entirely. Instead we fingerprint the
  // request by content: instructions + the first K messages identify the
  // chain; the leading lastSeenCount messages prove the client is extending
  // the same transcript rather than forking it.
  let stickyChainClaim: QwenAiStickyChainClaim | undefined
  let stickyChainEntry: import('../qwenAiStickyRegistry').StickyChainEntry | undefined
  let pendingStickyChainKey: string | undefined
  if (
    stickySessionEnabled
    && !qwenAiContinuationBinding
    && !responseStateEnabled
    && !previousResponseId
    && !managedToolResponsesRequest // store:false excluded it, but tools exist
    && Boolean(chatRequest.tools?.length)
    && chatRequest.tool_choice !== 'none'
    && requestIntent.intent !== 'context_compaction'
  ) {
    // Chain key = instructions + the first user message only. The head must
    // have a fixed width — using messages[0..K] breaks when K exceeds the
    // first turn's message count (system+user=2 vs later turns with more).
    const firstUserMessage = chatRequest.messages.find(m => m.role === 'user')
    const headMessages = firstUserMessage ? [firstUserMessage] : []
    const instructions = typeof request.instructions === 'string'
      ? request.instructions
      : undefined
    const chainKey = createQwenAiChainKey(instructions, headMessages)
    const claimResult = qwenAiStickyRegistry.claimByChainKey(chainKey)

    if (claimResult.status === 'busy') {
      abort.cleanup()
      ctx.set('Retry-After', String(Math.max(1, Math.ceil(claimResult.retryAfterMs / 1000))))
      ctx.status = 429
      ctx.body = {
        error: {
          message: 'The Qwen sticky chain is already in progress.',
          type: 'api_error',
          param: null,
          code: 'CHAT_IN_PROGRESS',
        },
      }
      return
    }

    if (claimResult.status === 'claimed') {
      stickyChainClaim = claimResult.claim
      stickyChainEntry = claimResult.entry
      const entry = claimResult.entry

      const bindingAccount = storeManager.getAccountById(entry.accountId)
      const bindingProvider = storeManager.getProviderById(entry.providerId)
      const bindingOwnershipMatches = bindingAccount?.providerId === bindingProvider?.id
        && bindingProvider !== undefined
        && QwenAiAdapter.isQwenAiProvider(bindingProvider)

      // Verify the client's history prefix matches what was already pushed.
      const prefixMessages = chatRequest.messages.slice(0, entry.lastSeenCount)
      const prefixOk = entry.lastSeenCount <= chatRequest.messages.length
        && createQwenAiTranscriptHash(prefixMessages) === entry.historyHash
      const deltaMessages = chatRequest.messages.slice(entry.lastSeenCount)

      if (bindingOwnershipMatches && prefixOk && deltaMessages.length > 0) {
        const deltaHash = createQwenAiDeltaHash(deltaMessages)
        const priorTicket = entry.appendedTurn
        if (priorTicket && priorTicket.deltaHash === deltaHash) {
          // Same delta already appended — resume the in-flight generation.
          qwenAiStickyResumeTicket = {
            prevResponseId: '',
            deltaHash: priorTicket.deltaHash,
            userFid: priorTicket.userFid,
            state: priorTicket.state,
          }
          qwenAiContinuationInputMessages = []
        } else {
          qwenAiContinuationInputMessages = deltaMessages
          console.info('[Responses] Qwen sticky chain continuation', JSON.stringify({
            requestId: responseId,
            chainKey: chainKey.slice(0, 16),
            accountId: entry.accountId,
            chatId: entry.chatId,
            lastSeenCount: entry.lastSeenCount,
            deltaMessageCount: deltaMessages.length,
            turnCount: entry.turnCount,
          }))
        }
      } else if (bindingOwnershipMatches && !prefixOk) {
        // History rewritten (compact / edit) — the upstream chat still holds
        // the old full transcript; append the whole current tail as the delta
        // so the model sees the compacted summary plus new content.
        qwenAiContinuationInputMessages = chatRequest.messages
        console.info('[Responses] Qwen sticky chain prefix mismatch; appending full transcript as delta', JSON.stringify({
          requestId: responseId,
          chainKey: chainKey.slice(0, 16),
          accountId: entry.accountId,
          chatId: entry.chatId,
        }))
      } else {
        // Dead chain — release both the claim and the entry so the next turn
        // registers a fresh one.
        qwenAiStickyRegistry.releaseChainClaim(stickyChainClaim)
        stickyChainClaim = undefined
        stickyChainEntry = undefined
        if (bindingOwnershipMatches) {
          qwenAiStickyRegistry.releaseChain(chainKey)
        }
      }
    }
    // 'missing' → fresh chain; will be registered after a successful turn.
    // Keep the key for the post-success registration path below.
    if (!stickyChainClaim) {
      pendingStickyChainKey = chainKey
    }
    // The binding itself is assembled after account selection below — the
    // forwarder requires actualModel to match the mapped model, which is only
    // known once selection resolves. At this stage we only pin the account.
    if (stickyChainEntry && (qwenAiContinuationInputMessages.length > 0 || qwenAiStickyResumeTicket)) {
      // Use the chain's account as preferred so selection lands on it.
      // The full binding is materialized post-selection.
    }
  }
  // -------------------------------------------------------------------------

  if (qwenAiContinuationBinding) {
    console.info('[Responses] Qwen session continuation candidate', JSON.stringify({
      requestId: responseId,
      providerId: qwenAiContinuationBinding.providerId,
      accountId: qwenAiContinuationBinding.accountId,
      toolResultCount: qwenAiContinuationInputMessages.length,
    }))
  }

  const imageResolver = createResponseImageResolver({ signal: abort.controller.signal })
  const mappedPreferredProviderId = modelMapper.getPreferredProvider(chatRequest.model)
  const mappedPreferredAccountId = modelMapper.getPreferredAccount(chatRequest.model)
  const preferredProviderId = qwenAiContinuationBinding?.providerId
    ?? stickyChainEntry?.providerId
    ?? mappedPreferredProviderId
  const preferredAccountId = qwenAiContinuationBinding?.accountId
    ?? stickyChainEntry?.accountId
    ?? mappedPreferredAccountId
  const initialSelection = loadBalancer.selectAccount(
    chatRequest.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId,
    new Set<string>(),
    qwenAiContinuationBinding || stickyChainEntry
      ? { allowQueuedQwenAiPreferredAccount: true }
      : stickySessionEnabled
        ? { preferLowStickyCount: true }
        : undefined,
  )
  if (!initialSelection) {
    abort.cleanup()
    releaseQwenAiToolCallClaim('no_available_account')
    if (stickyChainClaim) {
      qwenAiStickyRegistry.releaseChainClaim(stickyChainClaim)
      stickyChainClaim = undefined
    }
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${chatRequest.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  // Sticky chain: materialize the continuation binding now that selection has
  // resolved the mapped actualModel. The claim already holds the chain entry;
  // the binding just wraps it in the shape the forwarder validates against.
  if (stickyChainEntry && !qwenAiContinuationBinding) {
    const chainOnSelectedAccount = stickyChainEntry.accountId === initialSelection.account.id
      && stickyChainEntry.providerId === initialSelection.provider.id
    if (chainOnSelectedAccount) {
      qwenAiContinuationBinding = qwenAiStickyRegistry.chainToBinding(stickyChainEntry, {
        requestedModel: chatRequest.model,
        actualModel: initialSelection.actualModel,
        requestFingerprint: qwenAiRequestFingerprint ?? '',
      })
      console.info('[Responses] Qwen sticky chain binding materialized', JSON.stringify({
        requestId: responseId,
        accountId: initialSelection.account.id,
        chatId: stickyChainEntry.chatId,
        lastSeenCount: stickyChainEntry.lastSeenCount,
        deltaMessageCount: qwenAiContinuationInputMessages.length,
        resumeOnly: Boolean(qwenAiStickyResumeTicket),
      }))
    }
    // If selection landed elsewhere (e.g. the preferred account was busy), the
    // chain claim stays held — the write-back path re-registers a fresh chain
    // on the new account once the turn succeeds.
  }

  let initialUsesQwenAiContinuation = Boolean(
    qwenAiContinuationBinding
    && initialSelection.provider.id === qwenAiContinuationBinding.providerId
    && initialSelection.account.id === qwenAiContinuationBinding.accountId
    && initialSelection.actualModel === qwenAiContinuationBinding.actualModel,
  )
  if (
    qwenAiContinuationBinding
    && initialSelection.provider.id === qwenAiContinuationBinding.providerId
    && initialSelection.account.id === qwenAiContinuationBinding.accountId
    && initialSelection.actualModel !== qwenAiContinuationBinding.actualModel
  ) {
    clearQwenAiContinuationState('actual_model_changed')
    qwenAiContinuationBinding = undefined
    initialUsesQwenAiContinuation = false
  }

  const initialProviderIsQwenAi = QwenAiAdapter.isQwenAiProvider(initialSelection.provider)
  const qwenAiLogicalRecoveryState: QwenAiLogicalRecoveryState | undefined = initialProviderIsQwenAi
    ? {
        resumeAttempts: 0,
        workflowContinuationAttempts: 0,
        freshChatRestartAttempts: 0,
        accountNeutralReplayAttempts: 0,
        wrapperLeakRecoveryAttempts: 0,
        semanticFreshChatEscalations: 0,
      }
    : undefined
  // Egress-IP recovery must outlive a single account attempt: an aliyun verdict
  // is an exit-IP flag, so once the request escalates to the Webshare proxy it
  // must stay there for every later account of the SAME client request. One
  // ledger per request, shared by all failover attempts.
  const qwenAiEgressRecoveryState: QwenAiEgressRecoveryState | undefined = initialProviderIsQwenAi
    ? {
        webshareRetries: 0,
        useWebshareProxy: false,
      }
    : undefined
  const qwenAiSessionBridgeForSelection = (
    selection: AccountSelection,
  ): QwenAiSessionBridge | undefined => {
    // Sticky chains bypass the managed-tool gate (store:false clients), but
    // still need the fingerprint + continuation plumbing to reach the
    // forwarder. The fingerprint itself is only computed when the request has
    // tools, so its presence is sufficient proof the contract is intact.
    if (
      (!managedToolResponsesRequest && !stickyChainEntry && !pendingStickyChainKey)
      || !qwenAiRequestFingerprint
      || !QwenAiAdapter.isQwenAiProvider(selection.provider)
    ) {
      return undefined
    }

    const useContinuation = Boolean(
      qwenAiContinuationBinding
      && selection.provider.id === qwenAiContinuationBinding.providerId
      && selection.account.id === qwenAiContinuationBinding.accountId
      && selection.actualModel === qwenAiContinuationBinding.actualModel,
    )
    const stickyDeltaHash = useContinuation && qwenAiContinuationInputMessages.length > 0
      ? createQwenAiDeltaHash(qwenAiContinuationInputMessages)
      : undefined
    return {
      requestFingerprint: qwenAiRequestFingerprint,
      ...(stickyDeltaHash ? { stickyDeltaHash } : {}),
      ...(useContinuation ? {
        continuation: {
          binding: qwenAiContinuationBinding!,
          inputMessages: qwenAiContinuationInputMessages,
          ...(qwenAiStickyResumeTicket ? { resumeOnly: true } : {}),
        },
      } : {}),
    }
  }

  const createProxyContext = (
    selection: AccountSelection,
    deferManagedStreamCommit = false,
  ): ProxyContext => {
    const qwenAiSessionBridge = qwenAiSessionBridgeForSelection(selection)
    return {
      requestId: responseId,
      providerId: selection.provider.id,
      accountId: selection.account.id,
      model: chatRequest.model,
      actualModel: selection.actualModel,
      startTime: startedAt,
      isStream: chatRequest.stream === true,
      clientIP: clientIp(ctx),
      signal: abort.controller.signal,
      requestIntent: requestIntent.intent,
      ...(qwenAiLogicalRecoveryState ? { qwenAiLogicalRecoveryState } : {}),
      ...(qwenAiEgressRecoveryState ? { qwenAiEgressRecoveryState } : {}),
      ...(deferManagedStreamCommit ? { deferManagedStreamCommit: true } : {}),
      ...(qwenAiSessionBridge ? { qwenAiSessionBridge } : {}),
    }
  }
  let { account, provider, actualModel } = initialSelection
  let qwenAiStream: QwenAiOutputStream | undefined
  proxyStatusManager.recordRequestStart(chatRequest.model, provider.id, account.id)

  const failoverSelectionConstraints = initialProviderIsQwenAi
    && loadBalancer.hasCompleteQwenAiWebSession(initialSelection)
    ? {
        qwenAiWebSessionTier: 'complete' as const,
        ...(qwenAiContinuationBinding
          ? { allowQueuedQwenAiPreferredAccount: true }
          : {}),
      }
    : qwenAiContinuationBinding
      ? { allowQueuedQwenAiPreferredAccount: true }
      : undefined
  const activeAccountCount = initialProviderIsQwenAi
    ? storeManager.getAccountsByProviderId(initialSelection.provider.id)
      .filter(candidate => candidate.status === 'active')
      .length
    : 0
  const maxFailovers = resolveAccountFailoverLimit({
    configuredMaxFailovers: config.retryCount,
    qwenAiProvider: initialProviderIsQwenAi,
    activeAccountCount,
    qwenAiMaxAccountFailovers: process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS,
  })
  const deferManagedStreamCommit = initialProviderIsQwenAi
    && shouldDeferQwenAiManagedStreamCommit(chatRequest)

  const applyEffectiveSelection = (
    effectiveAccountId?: string,
    effectiveProviderId?: string,
    effectiveActualModel?: string,
  ) => {
    if (!effectiveAccountId) return
    const effectiveAccount = storeManager.getAccountById(effectiveAccountId)
    const effectiveProvider = storeManager.getProviderById(
      effectiveProviderId || effectiveAccount?.providerId || provider.id,
    )
    if (
      !effectiveAccount
      || !effectiveProvider
      || effectiveAccount.providerId !== effectiveProvider.id
    ) {
      return
    }

    account = effectiveAccount
    provider = effectiveProvider
    actualModel = effectiveActualModel || actualModel
  }
  const refreshEffectiveStreamSelection = () => {
    if (!qwenAiStream) return
    applyEffectiveSelection(
      qwenAiStream.qwenAiEffectiveAccountId,
      qwenAiStream.qwenAiEffectiveProviderId,
      qwenAiStream.qwenAiEffectiveActualModel,
    )
  }
  let responsesChunkCount = 0
  let lastResponsesChunkAt = 0
  let clientChunkCount = 0
  let lastClientChunkAt = 0
  let streamDeliveryLogged = false
  const logStreamDelivery = (outcome: 'completed' | 'failed', status: number, error?: Error) => {
    if (streamDeliveryLogged || chatRequest.stream !== true) return
    streamDeliveryLogged = true
    console.info('[Responses] stream-delivery', JSON.stringify({
      requestId: responseId,
      outcome,
      status,
      errorCode: streamFailureCode(error),
      elapsedMs: Date.now() - startedAt,
      responsesChunkCount,
      lastResponsesChunkAt,
      clientChunkCount,
      lastClientChunkAt,
    }))
  }

  let outcomeRecorded = false
  const recordSuccess = () => {
    // Release the sticky chain lease on success — the write-back in
    // storeConversation already ran (or will run), the claim is done.
    if (stickyChainClaim) {
      qwenAiStickyRegistry.releaseChainClaim(stickyChainClaim)
      stickyChainClaim = undefined
    }
    if (outcomeRecorded) return
    refreshEffectiveStreamSelection()
    outcomeRecorded = true
    logStreamDelivery('completed', 200)
    const latency = Date.now() - startedAt
    loadBalancer.clearAccountFailure(account.id)
    proxyStatusManager.recordRequestSuccess(latency)
    storeManager.incrementAccountUsage(account.id)
    storeManager.recordRequestInStats(true, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog('debug', 'Responses request completed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      actualModel,
      latency,
      isStream: chatRequest.stream === true,
    })
  }
  const recordFailure = (
    error: Error,
    status = 502,
    penalizeAccount = true,
    deferredStreamFailure = false,
  ) => {
    // Release the sticky chain lease BEFORE the outcomeRecorded guard — a
    // mid-stream failure after recordSuccess still needs the lease freed so
    // the client's retry can re-claim the chain.
    if (stickyChainClaim) {
      qwenAiStickyRegistry.releaseChainClaim(stickyChainClaim)
      stickyChainClaim = undefined
    }
    if (outcomeRecorded) return
    refreshEffectiveStreamSelection()
    outcomeRecorded = true
    logStreamDelivery('failed', status, error)
    const latency = Date.now() - startedAt
    const accountFault = streamFailureAccountFault(error, status)
    const retryScope = streamFailureRetryScope(error, status)
    const errorCode = streamFailureCode(error)
    const claimErrorCode = status === 499 ? undefined : errorCode
    // A dead in-flight remnant (upstream pinned the chat to a response that
    // emitted no bytes and never terminated) makes the retained chat
    // permanently busy — clear it like a stale branch even though the error
    // code is still CHAT_IN_PROGRESS.
    const deadInFlight = (error as { deadInFlight?: unknown } | undefined)?.deadInFlight === true
    const clearsPreviousBinding = (
      status !== 499
      &&
      initialUsesQwenAiContinuation
      && (
        deadInFlight
        || !isQwenAiChatInProgressErrorCode(claimErrorCode)
      )
      && (
        deadInFlight
        || isQwenAiSessionStaleErrorCode(claimErrorCode)
        || isQwenAiContinuationRejectedErrorCode(claimErrorCode)
        // A poisoned upstream chat must release the chain so a reconnect gets
        // a fresh chatId — otherwise the client re-binds to the same dead
        // branch and loops the identical verdict forever.
        || isQwenAiPoisonedChatErrorCode(claimErrorCode)
        || deferredStreamFailure
        || (
          accountFault === true
          && retryScope === 'next-account'
        )
      )
    )
    if (clearsPreviousBinding) {
      clearPreviousQwenAiSessionBinding(
        isQwenAiSessionStaleErrorCode(claimErrorCode)
          ? 'terminal_stale_session'
          : isQwenAiContinuationRejectedErrorCode(claimErrorCode)
            ? 'terminal_continuation_rejected'
            : isQwenAiPoisonedChatErrorCode(claimErrorCode)
              ? 'terminal_poisoned_chat'
            : accountFault === true && retryScope === 'next-account'
              ? 'terminal_account_failover'
            : 'terminal_stream_failure',
      )
      // Sticky chain: the upstream chat is gone or the account failed — drop
      // the chain so the next turn registers fresh on a different account.
      if (stickyChainEntry) {
        qwenAiStickyRegistry.releaseChain(stickyChainEntry.chainKey)
        stickyChainEntry = undefined
      }
    }
    finalizeFailedQwenAiToolCallClaim(
      claimErrorCode,
      accountFault,
      retryScope,
      isQwenAiSessionStaleErrorCode(claimErrorCode)
        ? 'terminal_stale_session'
        : isQwenAiContinuationRejectedErrorCode(claimErrorCode)
          ? 'terminal_continuation_rejected'
          : isQwenAiPoisonedChatErrorCode(claimErrorCode)
            ? 'terminal_poisoned_chat'
          : accountFault === true && retryScope === 'next-account'
            ? 'terminal_account_failover'
            : 'terminal_stream_failure',
    )
    const shouldPenalizeAccount = penalizeAccount && (
      !QwenAiAdapter.isQwenAiProvider(provider)
        ? accountFault !== false
        : isQwenAiAccountFault({
            accountFault,
            status,
            code: errorCode,
            errorCode,
            message: error.message,
          })
    )
    if (deferredStreamFailure && QwenAiAdapter.isQwenAiProvider(provider)) {
      qwenAiRequestGovernor.reportDeferredFailure(account.id, {
        success: false,
        status,
        headers: streamFailureHeaders(error),
        error: error.message,
        errorCode,
        retryable: false,
        accountFault: accountFault ?? shouldPenalizeAccount,
      }, requestIntent.intent)
    }
    proxyStatusManager.recordRequestFailure(latency)
    if (shouldPenalizeAccount && status !== 429 && status !== 499) {
      loadBalancer.markAccountFailed(account.id)
    }
    storeManager.recordRequestInStats(false, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog(status === 499 ? 'debug' : 'error', 'Responses request failed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      actualModel,
      latency,
      error: error.message,
      errorCode,
      data: { status, accountFault },
    })
  }
  const storeConversation = (
    output: Array<Record<string, any>>,
    qwenAiSessionState?: QwenAiSessionState,
  ) => {
    // --- Sticky chain write-back (store:false clients) ----------------------
    // The conversation store is skipped, but the sticky chain registry still
    // needs its tail pointer updated so the next turn can compute the delta.
    if (request.store === false && stickySessionEnabled) {
      const chainKey = pendingStickyChainKey ?? stickyChainEntry?.chainKey
      if (chainKey && qwenAiSessionState) {
        const binding = resolveQwenAiSessionBinding(qwenAiSessionState)
        if (binding) {
          const newLastSeenCount = chatRequest.messages.length
          const transcriptBytes = Buffer.byteLength(JSON.stringify(chatRequest.messages), 'utf8')
          qwenAiStickyRegistry.registerChain(chainKey, {
            accountId: binding.accountId,
            providerId: binding.providerId,
            chatId: binding.chatId,
            parentId: binding.parentId,
            historyHash: createQwenAiTranscriptHash(chatRequest.messages),
            lastSeenCount: newLastSeenCount,
            toolProtocol: binding.toolProtocol,
          })
          qwenAiStickyRegistry.updateChain(chainKey, {
            // approxBytes tracks the CURRENT transcript size — codex sends the
            // full history every turn, so the upstream chat size ≈ this turn's
            // bytes, not the cumulative sum (which would double-count).
            approxBytes: transcriptBytes,
            appendedTurn: initialUsesQwenAiContinuation && qwenAiContinuationInputMessages.length > 0
              ? {
                  deltaHash: createQwenAiDeltaHash(qwenAiContinuationInputMessages),
                  state: 'done',
                }
              : undefined,
          })
          console.info('[Responses] Qwen sticky chain updated', JSON.stringify({
            requestId: responseId,
            chainKey: chainKey.slice(0, 16),
            chatId: binding.chatId,
            lastSeenCount: newLastSeenCount,
          }))
        }
      }
    }
    if (stickyChainClaim) {
      qwenAiStickyRegistry.releaseChainClaim(stickyChainClaim)
      stickyChainClaim = undefined
    }
    // -------------------------------------------------------------------------

    if (request.store === false) {
      consumeQwenAiToolCallClaim('store_disabled')
      return
    }
    const appendedMessages = [
      ...translated.conversationMessages.slice(previousMessages.length),
      ...responseOutputToChatMessages(output),
    ]
    const appendedSidecarItems = [
      ...translated.sidecarItems,
      ...responseOutputToSidecarItems(output),
    ]
    const sidecarItems = [...previousSidecarItems, ...appendedSidecarItems]
    const transcript = [
      ...previousMessages,
      ...appendedMessages,
    ]
    const toolCallIds = responseOutputToolCallIds(output)
    // In sticky mode every successful response keeps the lineage alive, not
    // just tool-call turns — a plain-text reply still owns the chat tail that
    // the next user turn will append under.
    const wantsStickyBinding = stickySessionEnabled
      && managedToolResponsesRequest
    const resolvedBinding = managedToolResponsesRequest
      && (toolCallIds.length > 0 || wantsStickyBinding)
        ? resolveQwenAiSessionBinding(qwenAiSessionState)
        : undefined
    let qwenAiSessionBinding = request.store === false
      ? undefined
      : resolvedBinding
    if (qwenAiSessionBinding && wantsStickyBinding) {
      const lineageKey = previousQwenAiSessionBinding?.lineageKey
        ?? previousResponseId
        ?? responseId
      const appendedDelta = translated.conversationMessages.slice(previousMessages.length)
      const transcriptBytes = Buffer.byteLength(JSON.stringify(transcript), 'utf8')
      qwenAiSessionBinding = {
        ...qwenAiSessionBinding,
        lineageKey,
        transcriptHash: createQwenAiTranscriptHash(transcript),
        turnCount: (previousQwenAiSessionBinding?.turnCount ?? 0) + 1,
        approxBytes: (previousQwenAiSessionBinding?.approxBytes ?? 0) + transcriptBytes,
        appendedTurn: qwenAiStickyResumeTicket
          ? { ...qwenAiStickyResumeTicket, state: 'done' }
          : appendedDelta.length > 0 && initialUsesQwenAiContinuation
            ? {
                prevResponseId: previousResponseId ?? '',
                deltaHash: createQwenAiDeltaHash(appendedDelta),
                state: 'done',
              }
            : undefined,
      }
      if (qwenAiSessionBinding.appendedTurn?.prevResponseId === '') {
        // First turn of the lineage — nothing was "appended", the whole
        // transcript was uploaded. Keep the ticket undefined.
        qwenAiSessionBinding.appendedTurn = undefined
      }
      qwenAiStickyRegistry.register(lineageKey, qwenAiSessionBinding, {
        turnCount: qwenAiSessionBinding.turnCount,
        approxBytes: qwenAiSessionBinding.approxBytes,
      })
    }
    if (
      initialUsesQwenAiContinuation
      && qwenAiSessionBinding
      && previousQwenAiSessionBinding
      && (
        qwenAiSessionBinding.providerId !== previousQwenAiSessionBinding.providerId
        || qwenAiSessionBinding.accountId !== previousQwenAiSessionBinding.accountId
        || qwenAiSessionBinding.chatId !== previousQwenAiSessionBinding.chatId
      )
    ) {
      clearQwenAiContinuationState('continuation_replayed_full_history')
    }
    // Consume the preceding batch before adding a new one so a reused call ID
    // always belongs to the newest completed Qwen branch.
    consumeQwenAiToolCallClaim('continuation_consumed')
    if (qwenAiSessionBinding && toolCallIds.length > 0) {
      if (!qwenAiToolCallSessionStore.set(toolCallIds, qwenAiSessionBinding)) {
        storeManager.addLog('warn', 'Qwen tool-call session binding exceeded bounded cache limits', {
          requestId: responseId,
          providerId: qwenAiSessionBinding.providerId,
          accountId: qwenAiSessionBinding.accountId,
          model: chatRequest.model,
        })
      } else {
        storeManager.addLog('debug', 'Stored Qwen tool-call session binding', {
          requestId: responseId,
          providerId: qwenAiSessionBinding.providerId,
          accountId: qwenAiSessionBinding.accountId,
          model: chatRequest.model,
          data: {
            toolCallCount: toolCallIds.length,
            chatId: qwenAiSessionBinding.chatId,
            parentId: qwenAiSessionBinding.parentId,
          },
        })
      }
    }
    const stored = responsesConversationStore.set(
      responseId,
      transcript,
      qwenAiSessionBinding,
      {
        ...(previousResponseId ? { parentResponseId: previousResponseId } : {}),
        sidecarItems,
        deltaMessages: appendedMessages,
        deltaSidecarItems: appendedSidecarItems,
      },
    )
    if (!stored) {
      storeManager.addLog('warn', 'Responses context exceeded the bounded previous_response store', {
        requestId: responseId,
        model: chatRequest.model,
      })
    }
  }

  try {
    // Busy-failover stop reports the storm here once rotation is capped, so
    // the governor can bench the busy chain's accounts and engage the global
    // risk circuit instead of letting client reconnects re-attack the risk
    // gate. The forward closure collects every account that returned busy —
    // the terminal attempt never reaches onFailedAttempt. Declared at route
    // scope so the post-outcome Retry-After stamp can read the applied
    // cooldown after the failover promise resolves.
    const busyAccountIds: string[] = []
    let busyStormCooldownMs: number | undefined
    // Replays after an upstream-busy rejection carry a content-shaped
    // rejection risk: the same embedded-image history tripped the upstream
    // risk page on every account. Slim older embedded images on such retries
    // so the replay is smaller than the rejected shape. In 'always' mode the
    // first attempt is slimmed too, keeping ordinary turns below the
    // per-minute getstsToken quota. The store keeps its own transcript copy,
    // so slimming never mutates stored history.
    const imageSlimMode = qwenAiImageSlimModeFromEnv()
    let slimImagesOnNextAttempt = false
    const failoverPromise = forwardWithAccountFailover({
      initialSelection,
      maxFailovers,
      signal: abort.controller.signal,
      forward: async ({ selection }) => {
        const requestForAttempt = QwenAiAdapter.isQwenAiProvider(selection.provider)
            && shouldSlimQwenAiAttemptImages(imageSlimMode, slimImagesOnNextAttempt)
          ? { ...chatRequest, messages: slimQwenAiReplayImages(chatRequest.messages) }
          : chatRequest
        const result = await requestForwarder.forwardChatCompletion(
          requestForAttempt,
          selection.account,
          selection.provider,
          selection.actualModel,
          createProxyContext(
            selection,
            deferManagedStreamCommit,
          ),
        )
        if (!result.success && result.errorCode === 'qwen_ai_upstream_busy') {
          busyAccountIds.push(selection.account.id)
        }
        return result
      },
      shouldStopFailover: QwenAiAdapter.isQwenAiProvider(initialSelection.provider)
        ? combineQwenAiFailoverStopRules(
          createQwenAiBusyFailoverStopRule(undefined, {
            onRotationStopped: () => {
              busyStormCooldownMs = qwenAiRequestGovernor.reportQwenAiBusyStorm(busyAccountIds)
            },
          }),
          createQwenAiContentFailoverStopRule(),
        )
        : undefined,
      selectNext: excludedAccountIds => loadBalancer.selectAccount(
        chatRequest.model,
        config.loadBalanceStrategy,
        preferredProviderId,
        preferredAccountId,
        excludedAccountIds,
        failoverSelectionConstraints,
      ),
      onFailedAttempt: ({ selection, attempt }, result) => {
        if (result.errorCode === 'qwen_ai_upstream_busy') {
          slimImagesOnNextAttempt = true
        }
        if (QwenAiAdapter.isQwenAiProvider(selection.provider)) {
          qwenAiRequestGovernor.reportAccountFailover(selection.account.id, {
            requestId: responseId,
            status: result.status,
            errorCode: result.errorCode,
            attempt,
            accountFault: result.accountFault,
          })
        }
        if (
          !QwenAiAdapter.isQwenAiProvider(selection.provider)
            ? result.accountFault !== false
            : isQwenAiAccountFault(result)
        ) {
          loadBalancer.markAccountFailed(selection.account.id)
        }
        if (
          qwenAiContinuationBinding
          && selection.provider.id === qwenAiContinuationBinding.providerId
          && selection.account.id === qwenAiContinuationBinding.accountId
          && result.retryScope === 'next-account'
          && (
            result.accountFault === true
            || isQwenAiChatInProgressErrorCode(result.errorCode)
            || result.deadInFlight === true
          )
        ) {
          clearQwenAiContinuationState('account_failover')
          // A dead in-flight remnant pins the chain to a chat that can never
          // accept another turn. Drop the chain entry too so the next account
          // starts a fresh chat instead of inheriting the dead branch.
          if (result.deadInFlight === true && stickyChainEntry) {
            qwenAiStickyRegistry.releaseChain(stickyChainEntry.chainKey)
            stickyChainEntry = undefined
          }
        }
        storeManager.addLog('warn', 'Retrying Responses request with another account after upstream failure', {
          requestId: responseId,
          providerId: selection.provider.id,
          accountId: selection.account.id,
          model: chatRequest.model,
          errorCode: result.errorCode,
          data: {
            attempt,
            status: result.status,
            accountFault: result.accountFault,
          },
        })
      },
    })
    const outcome = deferManagedStreamCommit
      ? {
          selection: initialSelection,
          result: {
            success: true,
            status: 200,
            stream: createDeferredQwenAiFailoverStream(
              failoverPromise,
              abort.controller.signal,
            ),
            skipTransform: true,
          },
          failoverCount: 0,
          excludedAccountIds: new Set<string>(),
        }
      : await failoverPromise
    account = outcome.selection.account
    provider = outcome.selection.provider
    actualModel = outcome.selection.actualModel
    let result = outcome.result
    if (
      busyStormCooldownMs !== undefined
        && !result.success
        && result.errorCode === 'qwen_ai_upstream_busy'
    ) {
      // A cross-account busy storm was reported to the governor; pace the
      // client's reconnects with the applied cooldown instead of letting it
      // immediately re-attack the risk gate.
      result = {
        ...result,
        headers: {
          ...(result.headers || {}),
          'Retry-After': String(Math.max(1, Math.ceil(busyStormCooldownMs / 1000))),
        },
      }
      outcome.result = result
    }
    applyEffectiveSelection(
      result.effectiveAccountId,
      result.effectiveProviderId,
      result.effectiveActualModel,
    )

    if (!result.success) {
      abort.cleanup()
      const status = abort.controller.signal.aborted ? 499 : result.status ?? 500
      const failure = Object.assign(new Error(result.error ?? 'Request failed'), {
        status,
        code: result.errorCode,
        headers: result.headers,
        accountFault: result.accountFault,
        retryScope: result.retryScope,
      })
      recordFailure(
        failure,
        status,
        !QwenAiAdapter.isQwenAiProvider(provider)
          ? result.accountFault !== false
          : isQwenAiAccountFault(result),
      )
      const safeHeaders = sanitizeForwardedErrorHeaders(result.headers)
      if (safeHeaders) {
        Object.entries(safeHeaders).forEach(([name, value]) => ctx.set(name, value))
      }
      ctx.status = status
      ctx.body = {
        error: {
          message: result.error ?? 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      }
      return
    }

    if (chatRequest.stream === true) {
      if (!result.stream) {
        abort.cleanup()
        const error = new Error('Upstream returned no stream for a streaming Responses request.')
        recordFailure(error)
        ctx.status = 502
        ctx.body = {
          error: { message: error.message, type: 'api_error', param: null, code: 'missing_stream' },
        }
        return
      }

      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const rawStream = result.stream
      qwenAiStream = QwenAiAdapter.isQwenAiProvider(provider)
        ? rawStream as QwenAiOutputStream
        : undefined
      const chatStream = result.skipTransform
        ? rawStream
        : rawStream.pipe(streamHandler.createTransformStream(
          actualModel,
          `chatcmpl-${responseId.slice(5)}`,
          undefined,
          { requireDoneMarker: true },
        ))
      // Apply the same assistant-visible output boundary used by the Chat
      // route before converting Chat Completions SSE into Responses events.
      // This is deliberately route/protocol agnostic: structured tool call
      // arguments remain untouched by the boundary implementation.
      // Context compaction only needs the envelopes gone — failing the
      // summary because the model echoed history wrappers is never useful.
      const assistantStream = createAssistantOutputBoundaryStream(null, {
        stripOnly: requestIntent.intent === 'context_compaction',
      })
      const responsesStream = createResponsesStreamTransform({
        request,
        responseId,
        model: actualModel,
        createdAt,
        imageResolver,
        onComplete: (response) => {
          storeConversation(response.output, qwenAiStream?.qwenAiSessionState)
          recordSuccess()
        },
        onIncomplete: (response) => {
          // An incomplete terminal response may not have a reusable Qwen
          // parent branch. Keep the transcript, but make the next turn replay.
          storeConversation(response.output)
          recordSuccess()
        },
        onFailure: (error) => {
          const imageResolutionFailure = error instanceof ResponseImageResolutionError
          const status = imageResolutionFailure
            ? error.status
            : streamFailureStatus(error, abort.controller.signal.aborted)
          recordFailure(error, status, !imageResolutionFailure, !imageResolutionFailure)
        },
      }).start()

      // Qwen emits its semantic failure notification immediately before it
      // tears down the provider stream. A deferred/failover wrapper can emit
      // that notification without an observable `error` event (for example
      // when the source is already being destroyed). Do not rely on the
      // transport error to close the Responses stream: fail it directly so
      // clients always receive a terminal `response.failed` event instead of
      if (qwenAiStream) {
        const failResponsesStream = (error: Error) => {
          recordFailure(
            error,
            streamFailureStatus(error, abort.controller.signal.aborted),
            true,
            true,
          )
          if (!responsesStream.readableEnded && !responsesStream.writableEnded) {
            responsesStream.fail(error)
            // Qwen emits the failure notification before its terminal
            // `error/[DONE]` frames. Let the source drain those bytes and
            // close the transform from its normal end/close path; ending it
            // here races the next source write and produces a bare EOF.
            const sourceState = qwenAiStream as QwenAiOutputStream & {
              readableEnded?: boolean
              destroyed?: boolean
            }
            if (sourceState.readableEnded || sourceState.destroyed) {
              responsesStream.end()
            }
          }
        }
        qwenAiStream.once(QWEN_AI_STREAM_FAILURE_EVENT, failResponsesStream)
        if (qwenAiStream.qwenAiFailure) {
          queueMicrotask(() => failResponsesStream(qwenAiStream!.qwenAiFailure!))
        }
      }
      const clientStream = new SseKeepAliveStream()

      responsesStream.on('data', () => {
        responsesChunkCount += 1
        lastResponsesChunkAt = Date.now()
      })
      clientStream.on('data', () => {
        clientChunkCount += 1
        lastClientChunkAt = Date.now()
      })

      const sourceError = (error: Error) => {
        if (sourceFailureTriggered) return
        sourceFailureTriggered = true
        const status = streamFailureStatus(error, abort.controller.signal.aborted)
        if (!abort.controller.signal.aborted) {
          responsesStream.fail(error)
          responsesStream.end()
        } else {
          recordFailure(error, status, true, true)
        }
      }
      // A source can be destroyed without an Error (for example by an HTTP
      // socket reset). Node then emits `close` without `error` or `end`.
      // Convert that transport truncation into a structured Responses failure
      // so downstream clients never receive a bare EOF without a terminal
      // response event.
      let rawStreamEnded = false
      let chatStreamEnded = chatStream === rawStream
      let assistantStreamEnded = false
      let sourceFailureTriggered = false
      const sourceClose = (ended: () => boolean) => {
        if (ended()) return
        if (abort.controller.signal.aborted) return
        const incomplete = Object.assign(
          new Error('Upstream stream closed before completion.'),
          { status: 502, code: 'incomplete_upstream_stream', accountFault: false },
        )
        sourceError(incomplete)
      }
      rawStream.once('end', () => { rawStreamEnded = true })
      rawStream.once('close', () => sourceClose(() => rawStreamEnded))
      if (chatStream !== rawStream) {
        chatStream.once('end', () => { chatStreamEnded = true })
        chatStream.once('close', () => sourceClose(() => chatStreamEnded))
      }
      assistantStream.once('end', () => { assistantStreamEnded = true })
      assistantStream.once('close', () => sourceClose(() => assistantStreamEnded))
      rawStream.once('error', sourceError)
      if (chatStream !== rawStream) chatStream.once('error', sourceError)
      assistantStream.once('error', sourceError)
      responsesStream.once('error', (error: Error) => {
        const imageResolutionFailure = error instanceof ResponseImageResolutionError
        recordFailure(
          error,
          imageResolutionFailure
            ? error.status
            : streamFailureStatus(error, abort.controller.signal.aborted),
          !imageResolutionFailure,
          !imageResolutionFailure,
        )
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(assistantStream)
        destroyStream(clientStream)
      })
      responsesStream.once('end', abort.cleanup)
      abort.controller.signal.addEventListener('abort', () => {
        const cancellation = new Error('Client disconnected from Responses stream.')
        recordFailure(cancellation, 499, true, true)
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(assistantStream)
        destroyStream(responsesStream)
        destroyStream(clientStream)
      }, { once: true })

      responsesStream.pipe(clientStream)
      assistantStream.pipe(responsesStream)
      chatStream.pipe(assistantStream)
      ctx.body = clientStream
      return
    }

    const fallbackCompletion = {
      id: `chatcmpl-${responseId.slice(5)}`,
      object: 'chat.completion',
      created: createdAt,
      model: actualModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    const guardedBody = guardAssistantOutputCompletion(
      result.body ?? fallbackCompletion,
      null,
      { stripOnly: requestIntent.intent === 'context_compaction' },
    )
    const response = await chatCompletionToResponse(guardedBody, request, {
      id: responseId,
      model: actualModel,
      createdAt,
      imageResolver,
    })
    if (response.status === 'failed') {
      const error = Object.assign(
        new Error(response.error?.message ?? 'Upstream Responses output was not usable.'),
        { code: response.error?.code ?? 'invalid_upstream_response' },
      )
      recordFailure(error, 502, false)
      abort.cleanup()
      ctx.set('Content-Type', 'application/json')
      ctx.body = response
      return
    }
    storeConversation(
      response.output,
      response.status === 'completed' ? result.qwenAiSessionState : undefined,
    )
    recordSuccess()
    abort.cleanup()
    ctx.set('Content-Type', 'application/json')
    ctx.body = response
  } catch (error) {
    abort.cleanup()
    const caught = error instanceof Error ? error : new Error('Unknown Responses proxy error')
    const status = abort.controller.signal.aborted
      ? 499
      : caught instanceof ResponseImageResolutionError
        ? caught.status
        : 500
    recordFailure(caught, status, !(caught instanceof ResponseImageResolutionError))
    ctx.status = status
    ctx.body = {
      error: {
        message: caught.message,
        type: 'api_error',
        param: null,
        code: abort.controller.signal.aborted
          ? 'request_cancelled'
          : caught instanceof ResponseImageResolutionError
            ? caught.code
            : null,
      },
    }
  }
})

export default router
