/**
 * Management API - Gmail (Maton) helper routes
 * GET  /v0/management/gmail/config  → persisted gmailConfig (key redacted)
 * POST /v0/management/gmail/test    → connectivity probe (body may override form values)
 * POST /v0/management/gmail/code    → fetch Xiaomi OTP for an email (optional sinceMs)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import ConfigManager from '../../../store/config'
import {
  fetchGmailEmailCode,
  normalizeGmailRuntime,
  testGmailConnection,
} from '../../../lib/matonGmail'
import type { GmailConfig, GmailTestResult, ManagementApiResponse } from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/gmail' })

router.use(managementAuthMiddleware)

function persisted(): GmailConfig {
  return normalizeGmailRuntime(ConfigManager.get().gmailConfig)
}

function redact(cfg: GmailConfig): GmailConfig {
  return {
    ...cfg,
    matonApiKey: cfg.matonApiKey ? '***' : '',
  }
}

router.get('/config', async (ctx: Context) => {
  try {
    ctx.body = {
      success: true,
      data: redact(persisted()),
    } as ManagementApiResponse<GmailConfig>
  } catch (error) {
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    } as ManagementApiResponse
  }
})

router.post('/test', async (ctx: Context) => {
  try {
    const body = (ctx.request.body || {}) as Partial<GmailConfig>
    const current = persisted()
    const candidate = normalizeGmailRuntime({
      ...current,
      ...body,
      // Allow the UI to pass an unmasked key when the store still has ***.
      matonApiKey:
        body.matonApiKey && body.matonApiKey !== '***'
          ? body.matonApiKey
          : current.matonApiKey,
      matonConnectionId: body.matonConnectionId || current.matonConnectionId,
    })
    const result: GmailTestResult = await testGmailConnection(candidate)
    ctx.body = {
      success: true,
      data: result,
    } as ManagementApiResponse<GmailTestResult>
  } catch (error) {
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    } as ManagementApiResponse
  }
})

router.post('/code', async (ctx: Context) => {
  try {
    const body = (ctx.request.body || {}) as {
      email?: string
      sinceMs?: number
      gmailConfig?: Partial<GmailConfig>
    }
    const email = String(body.email || '').trim()
    if (!email) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: { code: 'invalid_request', message: 'email is required' },
      } as ManagementApiResponse
      return
    }

    const current = persisted()
    const candidate = normalizeGmailRuntime({
      ...current,
      ...(body.gmailConfig || {}),
      matonApiKey:
        body.gmailConfig?.matonApiKey && body.gmailConfig.matonApiKey !== '***'
          ? body.gmailConfig.matonApiKey
          : current.matonApiKey,
    })
    const code = await fetchGmailEmailCode(candidate, email, Number(body.sinceMs || 0))
    ctx.body = {
      success: true,
      data: { code },
    } as ManagementApiResponse<{ code: string }>
  } catch (error) {
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    } as ManagementApiResponse
  }
})

export default router
