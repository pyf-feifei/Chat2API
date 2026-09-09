/**
 * Management API - Webshare Proxy Routes
 * Persists the RGV587 recovery proxy config (single URL or key pool) and
 * applies it at runtime (no restart needed). Precedence: persisted config
 * over env. The key pool (`entries[]`) takes precedence over `proxyUrl`.
 */

import axios from 'axios'
import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { storeManager } from '../../../store/store'
import { generateWebshareEntryId, normalizeWebshareProxyConfig } from '../../../store/types'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import {
  disengageWebshareStickyMode,
  engageWebshareStickyMode,
  setWebshareProxyConfig,
  isWebshareProxyEnabled,
  isWebshareStickyActive,
  webshareProxyUrlForLog,
  websharePoolSnapshot,
  webshareStickySnapshot,
} from '../../webshareProxy'
import {
  applyWebshareSyncConfig,
  syncWebsharePoolNow,
  webshareSyncSnapshot,
} from '../../websharePoolSync'
import type {
  ManagementApiResponse,
  WebshareApiKeyEntry,
  WebshareProxyConfig,
  WebshareProxyEntry,
  WebshareProxyListItem,
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/webshare-proxy' })

router.use(managementAuthMiddleware)

type WebshareProxyStatusPayload = WebshareProxyConfig & {
  effective: {
    enabled: boolean
    proxyUrl: string
    /** Redacted exits of the currently healthy pool, in rotation order. */
    entries?: Array<{ proxyUrl: string; cooldownUntil: number; failureCount: number }>
  }
  /** Sticky mode runtime state (mode B: all Qwen traffic on the proxy). */
  sticky?: {
    active: boolean
    since: number
    reason: string
    nextProbeAt: number
    passedProbes: number
  }
  sync: {
    enabled: boolean
    intervalMinutes: number
    syncing: boolean
    lastSyncAt: number
    lastError: string
  }
  source: 'config' | 'env'
}

function persistedConfig(): WebshareProxyConfig | undefined {
  const raw = storeManager.getConfig().webshareProxyConfig
  return raw === undefined ? undefined : normalizeWebshareProxyConfig(raw)
}

/**
 * Apply the persisted config (if any) on first use. Deferring this from module
 * load keeps the route importable before the store finishes initialize();
 * the management routes mount after server bootstrap, so the first request
 * (and every mutation) sees the persisted state.
 */
let bootstrapConfigApplied = false
function applyRuntimeConfig(): void {
  if (bootstrapConfigApplied) return
  try {
    applyWebshareConfig(persistedConfig())
    bootstrapConfigApplied = true
  } catch {
    // Store not ready yet (import-time edge): the env fallback stays active
    // until a later request re-applies it.
  }
}

function applyWebshareConfig(config: WebshareProxyConfig | undefined): void {
  if (!config) {
    setWebshareProxyConfig(undefined)
    applyWebshareSyncConfig(undefined)
    return
  }
  setWebshareProxyConfig(
    { enabled: config.enabled, proxyUrl: config.proxyUrl },
    config.entries,
    config.rotationStrategy,
  )
  applyWebshareSyncConfig(config)
}

/** Re-read the persisted config after every mutation (PUT/DELETE). */
function applyPersistedConfigNow(): void {
  applyWebshareConfig(persistedConfig())
  bootstrapConfigApplied = true
}

function redactProxyUrl(proxyUrl: string): string {
  return proxyUrl
}

function statusPayload(config: WebshareProxyConfig | undefined): WebshareProxyStatusPayload {
  const runtimeEntries = websharePoolSnapshot()
  const sticky = webshareStickySnapshot()
  return {
    ...(config ?? { enabled: false, proxyUrl: '' }),
    // URLs shown in full for management UI; edits are by id.
    entries: config?.entries?.map(entry => ({ ...entry, proxyUrl: redactProxyUrl(entry.proxyUrl) })),
    effective: {
      enabled: isWebshareProxyEnabled(),
      proxyUrl: webshareProxyUrlForLog() ?? '',
      ...(runtimeEntries.length > 0
        ? {
            entries: runtimeEntries.map(entry => ({
              proxyUrl: redactProxyUrl(entry.proxyUrl),
              cooldownUntil: entry.cooldownUntil,
              failureCount: entry.failureCount,
            })),
          }
        : {}),
    },
    ...(isWebshareStickyActive() || sticky.active
      ? { sticky: { ...sticky, active: isWebshareStickyActive() } }
      : {}),
    sync: webshareSyncSnapshot(),
    source: config ? 'config' : 'env',
  }
}

function isValidProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return /^https?:$/.test(parsed.protocol)
  } catch {
    return false
  }
}

function invalidUrlError(ctx: Context, detail?: string): void {
  ctx.status = 400
  ctx.body = {
    success: false,
    error: {
      code: 'validation_error',
      message: detail
        ? `proxyUrl is not a valid http(s) proxy URL: ${detail}`
        : 'proxyUrl is not a valid http(s) proxy URL',
    },
  } as ManagementApiResponse
}

router.get('/config', async (ctx: Context) => {
  applyRuntimeConfig()
  ctx.body = {
    success: true,
    data: statusPayload(persistedConfig()),
  } as ManagementApiResponse<WebshareProxyStatusPayload>
})

/** Manual override: leave sticky mode immediately (probe-driven exit still exists). */
router.post('/sticky/disengage', async (ctx: Context) => {
  applyRuntimeConfig()
  disengageWebshareStickyMode('manual disengage via management API')
  ctx.body = {
    success: true,
    data: statusPayload(persistedConfig()),
  } as ManagementApiResponse<WebshareProxyStatusPayload>
})

/**
 * Manual override: engage sticky mode now. Useful to pre-warm the proxy exit
 * (e.g. the operator already knows the direct IP is risk-controlled) instead
 * of waiting for the first request to fail through the recovery path.
 */
router.post('/sticky/engage', async (ctx: Context) => {
  // Load the persisted config first: on a fresh process the runtime module
  // still follows env until any config route touches it.
  applyRuntimeConfig()
  if (!isWebshareProxyEnabled()) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: {
        code: 'validation_error',
        message: 'The Webshare proxy must be enabled before engaging sticky mode',
      },
    } as ManagementApiResponse
    return
  }
  engageWebshareStickyMode('manual engage via management API')
  ctx.body = {
    success: true,
    data: statusPayload(persistedConfig()),
  } as ManagementApiResponse<WebshareProxyStatusPayload>
})

router.put('/config', async (ctx: Context) => {
  const body = ctx.request.body as Partial<WebshareProxyConfig> | undefined
  if (!body || typeof body !== 'object') {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'validation_error', message: 'Request body must be a config object' },
    } as ManagementApiResponse
    return
  }

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'validation_error', message: 'enabled must be a boolean' },
    } as ManagementApiResponse
    return
  }

  const current = persistedConfig()

  // --- single-URL field ---
  if (body.proxyUrl !== undefined && typeof body.proxyUrl !== 'string') {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'validation_error', message: 'proxyUrl must be a string' },
    } as ManagementApiResponse
    return
  }
  const nextProxyUrl = (body.proxyUrl ?? current?.proxyUrl ?? '').trim()
  if (body.proxyUrl !== undefined && body.proxyUrl.trim() && !isValidProxyUrl(body.proxyUrl)) {
    invalidUrlError(ctx, 'protocol must be http or https')
    return
  }

  // --- entries pool ---
  let entries: WebshareProxyEntry[] | undefined = current?.entries
  if (body.entries !== undefined) {
    if (!Array.isArray(body.entries)) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: { code: 'validation_error', message: 'entries must be an array' },
      } as ManagementApiResponse
      return
    }
    const normalized: WebshareProxyEntry[] = []
    for (const raw of body.entries) {
      if (!raw || typeof raw !== 'object') {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: { code: 'validation_error', message: 'each entry must be an object' },
        } as ManagementApiResponse
        return
      }
      const record = raw as Record<string, unknown>
      const proxyUrl = typeof record.proxyUrl === 'string' ? record.proxyUrl.trim() : ''
      // Redacted URLs (from GET) are skips, not errors: the UI round-trips
      // the entry list and only changed/added rows carry a raw URL.
      const redacted = !proxyUrl || proxyUrl.includes('***')
      if (!redacted && !isValidProxyUrl(proxyUrl)) {
        invalidUrlError(ctx, 'protocol must be http or https')
        return
      }
      const id = typeof record.id === 'string' && record.id ? record.id : generateWebshareEntryId()
      const previous = current?.entries?.find(candidate => candidate.id === id)
      if (!proxyUrl && !previous) {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: { code: 'validation_error', message: 'entries[].proxyUrl is required' },
        } as ManagementApiResponse
        return
      }
      normalized.push({
        id,
        name: typeof record.name === 'string' ? record.name.trim() : '',
        proxyUrl: redacted && previous ? previous.proxyUrl : proxyUrl,
        enabled: record.enabled !== false,
        lastUsed: previous?.lastUsed,
        cooldownUntil: previous?.cooldownUntil,
        failureCount: previous?.failureCount ?? 0,
        sourceKeyId: previous?.sourceKeyId,
        createdAt: previous?.createdAt ?? Date.now(),
      })
    }
    entries = normalized.length > 0 ? normalized : undefined
  }

  let apiKeys: WebshareApiKeyEntry[] | undefined = current?.apiKeys
  if (body.apiKeys !== undefined) {
    if (!Array.isArray(body.apiKeys)) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: { code: 'validation_error', message: 'apiKeys must be an array' },
      } as ManagementApiResponse
      return
    }
    const normalizedKeys: WebshareApiKeyEntry[] = []
    for (const raw of body.apiKeys) {
      if (!raw || typeof raw !== 'object') {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: { code: 'validation_error', message: 'each apiKey entry must be an object' },
        } as ManagementApiResponse
        return
      }
      const record = raw as Record<string, unknown>
      const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
      const id = typeof record.id === 'string' && record.id ? record.id : generateWebshareEntryId()
      const previous = current?.apiKeys?.find(candidate => candidate.id === id)
      const resolved = apiKey || previous?.apiKey || ''
      if (!resolved) {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: { code: 'validation_error', message: 'apiKeys[].apiKey is required' },
        } as ManagementApiResponse
        return
      }
      normalizedKeys.push({
        id,
        label: typeof record.label === 'string' ? record.label.trim() : previous?.label ?? '',
        apiKey: resolved,
        createdAt: previous?.createdAt ?? Date.now(),
      })
    }
    apiKeys = normalizedKeys.length > 0 ? normalizedKeys : undefined
  }

  if (body.rotationStrategy !== undefined) {
    if (!['round-robin', 'random', 'failover'].includes(String(body.rotationStrategy))) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: { code: 'validation_error', message: 'rotationStrategy must be round-robin, random, or failover' },
      } as ManagementApiResponse
      return
    }
  }

  const enabled = body.enabled === true || (body.enabled === undefined && current?.enabled === true)
  const hasPool = Boolean(entries && entries.length > 0)
  const hasSingle = Boolean(nextProxyUrl)
  const hasKeys = Boolean(apiKeys && apiKeys.length > 0)
if (enabled && !hasPool && !hasSingle && !hasKeys) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'validation_error', message: 'A proxy URL, at least one pool entry, or at least one API key is required to enable the Webshare proxy' },
    } as ManagementApiResponse
    return
  }

  const rotationStrategy = body.rotationStrategy !== undefined
    ? body.rotationStrategy
    : current?.rotationStrategy
  const autoSync = typeof body.autoSync === 'boolean' ? body.autoSync : current?.autoSync
  const syncIntervalMinutes = typeof body.syncIntervalMinutes === 'number'
    ? body.syncIntervalMinutes
    : current?.syncIntervalMinutes

  const next: WebshareProxyConfig = {
    enabled,
    proxyUrl: nextProxyUrl,
    ...(hasPool ? { entries } : {}),
    ...(hasPool ? { rotationStrategy } : {}),
    ...(apiKeys ? { apiKeys } : {}),
    ...(autoSync !== undefined ? { autoSync } : {}),
    ...(syncIntervalMinutes !== undefined ? { syncIntervalMinutes } : {}),
  }

  const updated = ConfigManager.update({ webshareProxyConfig: next }).webshareProxyConfig
  applyPersistedConfigNow()

  ctx.body = {
    success: true,
    data: statusPayload(updated ?? next),
  } as ManagementApiResponse<WebshareProxyStatusPayload>
})

router.post('/api-keys/proxy-list', async (ctx: Context) => {
  const body = ctx.request.body as { apiKey?: unknown; page?: unknown } | undefined
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'validation_error', message: 'apiKey is required' },
    } as ManagementApiResponse
    return
  }
  const page = typeof body?.page === 'number' && body.page >= 1 ? Math.floor(body.page) : 1
  const mode = typeof body?.mode === 'string' && body.mode.trim() ? body.mode.trim() : 'direct'
  try {
    const response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
      params: { mode, page, page_size: 100 },
      headers: { Authorization: `Token ${apiKey}` },
      timeout: 20000,
      validateStatus: () => true,
    })
    if (response.status === 401 || response.status === 403) {
      ctx.status = 401
      ctx.body = {
        success: false,
        error: { code: 'webshare_auth_failed', message: `Webshare API rejected the key (HTTP ${response.status})` },
      } as ManagementApiResponse
      return
    }
    if (response.status !== 200) {
      ctx.status = 502
      ctx.body = {
        success: false,
        error: { code: 'webshare_upstream_error', message: `Webshare API returned HTTP ${response.status}` },
      } as ManagementApiResponse
      return
    }
    const data = response.data as { count?: unknown; results?: unknown }
    const results = Array.isArray(data?.results) ? data.results : []
    const items: WebshareProxyListItem[] = results
      .map((raw): WebshareProxyListItem => {
        const record = raw as Record<string, unknown>
        return {
          ipAddress: String(record.proxy_address ?? record.ip_address ?? ''),
          port: typeof record.port === 'number' ? record.port : Number(record.port ?? 0),
          username: String(record.username ?? ''),
          password: String(record.password ?? ''),
          country: String(record.country_code ?? record.country ?? ''),
          countryName: String(record.country_name ?? record.country_code ?? ''),
          city: String(record.city_name ?? record.city ?? ''),
          valid: record.valid !== false,
        }
      })
      .filter(item => item.ipAddress.length > 0)
    ctx.body = {
      success: true,
      data: {
        count: typeof data?.count === 'number' ? data.count : items.length,
        page,
        items,
      },
    } as ManagementApiResponse<{ count: number; page: number; items: WebshareProxyListItem[] }>
  } catch (error) {
    ctx.status = 502
    ctx.body = {
      success: false,
      error: {
        code: 'webshare_request_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    } as ManagementApiResponse
  }
})

router.post('/sync', async (ctx: Context) => {
  applyRuntimeConfig()
  await syncWebsharePoolNow('manual')
  ctx.body = {
    success: true,
    data: statusPayload(persistedConfig()),
  } as ManagementApiResponse<WebshareProxyStatusPayload>
})
router.delete('/config', async (ctx: Context) => {
  ConfigManager.update({ webshareProxyConfig: undefined })
  applyPersistedConfigNow()
  ctx.body = {
    success: true,
    data: statusPayload(undefined),
  } as ManagementApiResponse<WebshareProxyStatusPayload>
})

export default router
