import Router from '@koa/router'
import type { RouterContext } from '@koa/router'
import type { Context } from 'koa'
import { loadBalancer } from '../loadbalancer'
import { modelMapper } from '../modelMapper'
import { requestForwarder } from '../forwarder'
import { proxyStatusManager } from '../status'
import { storeManager } from '../../store/store'
import {
  chatCompletionStreamToGeminiSse,
  chatCompletionToGeminiResponse,
  geminiToChatCompletionRequest,
} from '../gemini/translator'
import { geminiFileStore } from '../gemini/fileStore'
import type { ProxyContext } from '../types'

const router = new Router()
const generateContentRoutePattern = /^\/v1beta\/models\/(.+):generateContent$/
const streamGenerateContentRoutePattern = /^\/v1beta\/models\/(.+):streamGenerateContent$/

function requestId(): string {
  return `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function getModelResource(model: string, ownedBy = 'chat2api'): any {
  return {
    name: `models/${model}`,
    version: model,
    displayName: model,
    description: `Chat2API routed model ${model}`,
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    owned_by: ownedBy,
  }
}

function selectModel(model: string) {
  const config = storeManager.getConfig()
  const selection = loadBalancer.selectAccount(
    model,
    config.loadBalanceStrategy,
    modelMapper.getPreferredProvider(model),
    modelMapper.getPreferredAccount(model),
  )
  return selection
}

function createClientAbortSignal(ctx: Context): AbortSignal {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', abort)
  return controller.signal
}

async function forwardGemini(ctx: Context, stream: boolean): Promise<void> {
  const model = ctx.params.model
  const startTime = Date.now()
  const selection = selectModel(model)

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        code: 503,
        message: `No available account for model: ${model}`,
        status: 'UNAVAILABLE',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection
  const chatRequest = {
    ...geminiToChatCompletionRequest(model, ctx.request.body || {}),
    stream,
  }
  const context: ProxyContext = {
    requestId: requestId(),
    providerId: provider.id,
    accountId: account.id,
    model,
    actualModel,
    startTime,
    isStream: stream,
    clientIP: ctx.ip,
    signal: createClientAbortSignal(ctx),
  }

  proxyStatusManager.recordRequestStart(model, provider.id, account.id)
  const result = await requestForwarder.forwardChatCompletion(chatRequest, account, provider, actualModel, context)

  if (!result.success) {
    proxyStatusManager.recordRequestFailure(Date.now() - startTime)
    ctx.status = result.status || 500
    ctx.body = {
      error: {
        code: ctx.status,
        message: result.error || 'Gemini-compatible request failed',
        status: 'INTERNAL',
      },
    }
    return
  }

  proxyStatusManager.recordRequestSuccess(Date.now() - startTime)

  if (stream && result.stream) {
    ctx.set('Content-Type', 'text/event-stream')
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = result.skipTransform
      ? chatCompletionStreamToGeminiSse(result.stream, actualModel)
      : chatCompletionStreamToGeminiSse(result.stream, actualModel)
    return
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = chatCompletionToGeminiResponse(result.body, actualModel)
}

function setCapturedModelParam(ctx: RouterContext): void {
  const captures = ctx.captures || []
  const model = captures[0] || ''
  ctx.params = {
    ...ctx.params,
    model: decodeURIComponent(model.replace(/^models\//, '')),
  }
}

router.get('/v1beta/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(provider => provider.enabled)
  const models: any[] = []
  const added = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id).filter(account => account.status === 'active')
    if (accounts.length === 0) continue
    for (const model of storeManager.getEffectiveModels(provider.id)) {
      if (added.has(model.displayName)) continue
      added.add(model.displayName)
      models.push(getModelResource(model.displayName, provider.name))
    }
  }

  ctx.body = { models }
})

router.get('/v1beta/models/:model', async (ctx: Context) => {
  ctx.body = getModelResource(ctx.params.model)
})

router.post(generateContentRoutePattern, async (ctx: Context) => {
  setCapturedModelParam(ctx)
  await forwardGemini(ctx, false)
})

router.post(streamGenerateContentRoutePattern, async (ctx: Context) => {
  setCapturedModelParam(ctx)
  await forwardGemini(ctx, true)
})

router.post('/upload/v1beta/files', async (ctx: Context) => {
  try {
    const file = ctx.get('X-Goog-Upload-Protocol')
      ? geminiFileStore.createUploadSession(ctx)
      : geminiFileStore.createSimpleFile(ctx)
    ctx.body = { file }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Gemini file upload failed' } }
  }
})

router.post('/upload/v1beta/files/:id', async (ctx: Context) => {
  try {
    const file = geminiFileStore.storeUploadChunk(ctx.params.id, ctx)
    ctx.body = { file }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Gemini file upload failed' } }
  }
})

router.get('/v1beta/files/:id', async (ctx: Context) => {
  const file = geminiFileStore.getFile(`files/${ctx.params.id}`)
  if (!file) {
    ctx.status = 404
    ctx.body = { error: { message: `File not found: files/${ctx.params.id}` } }
    return
  }
  ctx.body = { file }
})

router.delete('/v1beta/files/:id', async (ctx: Context) => {
  geminiFileStore.deleteFile(`files/${ctx.params.id}`)
  ctx.status = 200
  ctx.body = {}
})

export default router
