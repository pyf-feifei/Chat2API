/**
 * Maton Gmail helper (port of skills/gmail/scripts/maton_gmail.py).
 *
 * Used to fetch Xiaomi verification codes during MiMo account login/import
 * and to probe connectivity from Settings → Gmail.
 */

import type { GmailConfig, GmailTestResult } from '../../shared/types.ts'

const DEFAULT_GATEWAY = 'https://gateway.maton.ai/google-mail'
const DEFAULT_CONTROL = 'https://ctrl.maton.ai'
const TIMEOUT_MS = 30_000

export function normalizeGmailRuntime(config: Partial<GmailConfig> | null | undefined): GmailConfig {
  return {
    enabled: config?.enabled === true,
    matonApiKey: (config?.matonApiKey || '').trim(),
    matonConnectionId: (config?.matonConnectionId || '').trim(),
    gatewayBaseUrl: (config?.gatewayBaseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_GATEWAY,
    controlBaseUrl: (config?.controlBaseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_CONTROL,
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string
    apiKey: string
    connectionId?: string
    query?: Record<string, string | number | undefined | null>
    body?: unknown
    timeoutMs?: number
  },
): Promise<unknown> {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    Accept: 'application/json',
  }
  if (options.connectionId) {
    headers['Maton-Connection'] = options.connectionId
  }

  const init: RequestInit = {
    method: options.method || 'GET',
    headers,
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText} ${text.slice(0, 300)}`.trim())
      ;(error as Error & { httpStatus?: number }).httpStatus = response.status
      throw error
    }
    if (!text) return {}
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
  }
}

export async function listGmailConnections(config: Partial<GmailConfig>): Promise<unknown> {
  const cfg = normalizeGmailRuntime(config)
  return requestJson(cfg.controlBaseUrl, '/connections', {
    apiKey: cfg.matonApiKey,
    query: { app: 'google-mail', status: 'ACTIVE' },
  })
}

export async function listGmailMessages(
  config: Partial<GmailConfig>,
  options: { query?: string; maxResults?: number; includeSpamTrash?: boolean } = {},
): Promise<unknown> {
  const cfg = normalizeGmailRuntime(config)
  return requestJson(cfg.gatewayBaseUrl, '/gmail/v1/users/me/messages', {
    apiKey: cfg.matonApiKey,
    connectionId: cfg.matonConnectionId,
    query: {
      maxResults: options.maxResults ?? 8,
      q: options.query,
      includeSpamTrash: options.includeSpamTrash ? 'true' : undefined,
    },
  })
}

export async function getGmailMessage(
  config: Partial<GmailConfig>,
  messageId: string,
  format = 'full',
): Promise<unknown> {
  const cfg = normalizeGmailRuntime(config)
  return requestJson(cfg.gatewayBaseUrl, `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`, {
    apiKey: cfg.matonApiKey,
    connectionId: cfg.matonConnectionId,
    query: { format },
  })
}

/**
 * Round-trip probe: list recent messages (or connections when no connection id).
 * Never throws — returns a structured result for the settings UI.
 */
export async function testGmailConnection(config: Partial<GmailConfig>): Promise<GmailTestResult> {
  const cfg = normalizeGmailRuntime(config)
  if (!cfg.matonApiKey) {
    return { ok: false, message: 'missingApiKey' }
  }

  try {
    if (cfg.matonConnectionId) {
      const listed = (await listGmailMessages(cfg, { maxResults: 1 })) as {
        messages?: unknown[]
        resultSizeEstimate?: number
      } | null
      return {
        ok: true,
        message: 'ok',
        endpoint: `${cfg.gatewayBaseUrl}/gmail/v1/users/me/messages`,
        reply: `messages=${Array.isArray(listed?.messages) ? listed.messages.length : 0}`,
      }
    }

    const connections = (await listGmailConnections(cfg)) as { connections?: unknown[] } | null
    const count = Array.isArray(connections?.connections) ? connections.connections.length : 0
    return {
      ok: true,
      message: 'ok',
      endpoint: `${cfg.controlBaseUrl}/connections`,
      reply: `activeConnections=${count}`,
    }
  } catch (error) {
    const err = error as Error & { httpStatus?: number }
    if (err?.name === 'AbortError') {
      return { ok: false, message: 'timeout' }
    }
    const text = err?.message || String(error)
    if (typeof err?.httpStatus === 'number') {
      return {
        ok: false,
        message: 'httpError',
        endpoint: cfg.matonConnectionId ? cfg.gatewayBaseUrl : cfg.controlBaseUrl,
        reply: text.slice(0, 300),
      }
    }
    return {
      ok: false,
      message: 'networkError',
      endpoint: cfg.matonConnectionId ? cfg.gatewayBaseUrl : cfg.controlBaseUrl,
      reply: text.slice(0, 300),
    }
  }
}

function decodeBase64Url(data: string): string {
  try {
    const padded = data + '='.repeat((4 - (data.length % 4)) % 4)
    const buf = Buffer.from(padded, 'base64')
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

function walkParts(node: Record<string, unknown>, out: string[]): void {
  const body = node.body as { data?: string } | undefined
  if (body?.data) {
    out.push(decodeBase64Url(body.data))
  }
  const parts = node.parts as Record<string, unknown>[] | undefined
  if (Array.isArray(parts)) {
    for (const part of parts) walkParts(part, out)
  }
}

export function decodeGmailMessageText(message: Record<string, unknown>): string {
  const parts = [String(message.snippet || '')]
  const payload = (message.payload || {}) as Record<string, unknown>
  const collected: string[] = []
  walkParts(payload, collected)
  return [...parts, ...collected].join('\n')
}

const CODE_PATTERNS = [
  /验证码[是为:：\s]*([0-9]{6})/i,
  /verification code is[:\s]*([0-9]{6})/i,
  /code is[:\s]*([0-9]{6})/i,
  /\b([0-9]{6})\b/,
]

export function extractEmailCode(text: string): string {
  for (const pattern of CODE_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[1]) return match[1]
  }
  return ''
}

/**
 * Return the newest Xiaomi 6-digit code delivered to toEmail after sinceMs.
 * Port of scripts/mimo-login/login.py fetch_gmail_email_code.
 */
export async function fetchGmailEmailCode(
  config: Partial<GmailConfig>,
  toEmail: string,
  sinceMs: number,
): Promise<string> {
  const cfg = normalizeGmailRuntime(config)
  if (!cfg.matonApiKey || !cfg.matonConnectionId) return ''

  const query = `from:(notice.xiaomi.com OR xiaomi.com) to:${toEmail} newer_than:15m`
  const listed = (await listGmailMessages(cfg, {
    query,
    maxResults: 8,
    includeSpamTrash: true,
  })) as { messages?: Array<{ id?: string }> } | null

  let bestCode = ''
  let bestTs = 0

  for (const item of listed?.messages || []) {
    const messageId = String(item.id || '')
    if (!messageId) continue
    let message: Record<string, unknown>
    try {
      message = (await getGmailMessage(cfg, messageId, 'full')) as Record<string, unknown>
    } catch {
      continue
    }
    const ts = Number(message.internalDate || 0)
    if (ts < sinceMs || ts < bestTs) continue

    const headers = ((message.payload as Record<string, unknown> | undefined)?.headers || []) as Array<{
      name?: string
      value?: string
    }>
    const toHeaders = headers
      .filter((h) => String(h.name || '').toLowerCase() === 'to')
      .map((h) => String(h.value || ''))
    const joined = toHeaders.join(' ').toLowerCase()
    const body = decodeGmailMessageText(message)
    const emailOk =
      joined.includes(toEmail.toLowerCase()) ||
      body.toLowerCase().includes(toEmail.toLowerCase()) ||
      body.toLowerCase().includes('xiaomi') ||
      body.includes('小米')

    if (!emailOk) continue

    const code = extractEmailCode(body)
    if (code) {
      bestCode = code
      bestTs = ts
    }
  }

  return bestCode
}
