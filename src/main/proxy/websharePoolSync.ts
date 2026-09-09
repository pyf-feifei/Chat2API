/**
 * Webshare pool auto-sync.
 *
 * The management UI stores Webshare dashboard API keys; every exit IP listed
 * under a key belongs to the rotation pool by default. This module keeps the
 * persisted pool (`webshareProxyConfig.entries`) in sync with each key's live
 * Proxy List:
 *  - on config save and on a periodic timer (auto sync),
 *  - merged by proxy URL so runtime state (cooldown / failure count / enabled
 *    flag), manual entries, and human-given names survive every sync,
 *  - entries tagged with `sourceKeyId` are owned by their key: exits that
 *    disappear from the key's list are dropped on the next successful sync;
 *    a key whose fetch fails keeps its last known exits.
 */
import axios from 'axios'
import ConfigManager from '../store/config'
import { storeManager } from '../store/store'
import { generateWebshareEntryId, normalizeWebshareProxyConfig } from '../store/types'
import type {
  WebshareProxyConfig,
  WebshareProxyEntry,
  WebshareProxyListItem,
} from '../../shared/types'
import { setWebshareProxyConfig } from './webshareProxy'

const WEBSHARE_LIST_URL = 'https://proxy.webshare.io/api/v2/proxy/list/'
export const DEFAULT_WEBSHARE_SYNC_INTERVAL_MINUTES = 30
const MIN_SYNC_INTERVAL_MINUTES = 5
const MAX_SYNC_INTERVAL_MINUTES = 1440
const MAX_PAGES_PER_KEY = 3

export interface WebshareSyncSnapshot {
  enabled: boolean
  intervalMinutes: number
  syncing: boolean
  lastSyncAt: number
  lastError: string
}

const syncState: WebshareSyncSnapshot = {
  enabled: false,
  intervalMinutes: DEFAULT_WEBSHARE_SYNC_INTERVAL_MINUTES,
  syncing: false,
  lastSyncAt: 0,
  lastError: '',
}

let timer: ReturnType<typeof setInterval> | undefined

export function webshareSyncSnapshot(): WebshareSyncSnapshot {
  return { ...syncState }
}

function clampInterval(minutes: number | undefined): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return DEFAULT_WEBSHARE_SYNC_INTERVAL_MINUTES
  }
  return Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.round(minutes)))
}

function persistedConfig(): WebshareProxyConfig | undefined {
  const raw = storeManager.getConfig().webshareProxyConfig
  return raw === undefined ? undefined : normalizeWebshareProxyConfig(raw)
}

/**
 * (Re)arm the sync timer from the persisted config. Passing undefined (config
 * section deleted) stops syncing entirely.
 */
export function applyWebshareSyncConfig(
  config: WebshareProxyConfig | undefined,
  options: { syncNow?: boolean } = {},
): void {
  const keys = config?.apiKeys ?? []
  const enabled = keys.length > 0 && config?.autoSync !== false
  const intervalMinutes = clampInterval(config?.syncIntervalMinutes)
  syncState.enabled = enabled
  syncState.intervalMinutes = intervalMinutes
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  if (enabled) {
    timer = setInterval(() => {
      void syncWebsharePoolNow('timer')
    }, intervalMinutes * 60_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  if (enabled && options.syncNow !== false) {
    void syncWebsharePoolNow('config-apply')
  }
}

async function fetchKeyList(apiKey: string): Promise<WebshareProxyListItem[]> {
  const items: WebshareProxyListItem[] = []
  let page = 1
  for (;;) {
    const response = await axios.get(WEBSHARE_LIST_URL, {
      params: { mode: 'direct', page, page_size: 100 },
      headers: { Authorization: `Token ${apiKey}` },
      timeout: 20_000,
      validateStatus: () => true,
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Webshare API rejected the key (HTTP ${response.status})`)
    }
    if (response.status !== 200) {
      throw new Error(`Webshare API returned HTTP ${response.status}`)
    }
    const data = response.data as { next?: unknown; results?: unknown }
    const results = Array.isArray(data?.results) ? data.results : []
    for (const raw of results) {
      const record = raw as Record<string, unknown>
      const ipAddress = String(record.proxy_address ?? record.ip_address ?? '')
      if (!ipAddress) continue
      items.push({
        ipAddress,
        port: typeof record.port === 'number' ? record.port : Number(record.port ?? 0),
        username: String(record.username ?? ''),
        password: String(record.password ?? ''),
        country: String(record.country_code ?? record.country ?? ''),
        countryName: String(record.country_name ?? record.country_code ?? ''),
        city: String(record.city_name ?? record.city ?? ''),
        valid: record.valid !== false,
      })
    }
    if (!data?.next || page >= MAX_PAGES_PER_KEY) break
    page += 1
  }
  return items
}

function buildEntryUrl(item: WebshareProxyListItem): string {
  return `http://${item.username}:${item.password}@${item.ipAddress}:${item.port}`
}

function hostPortOf(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl)
    return `${parsed.hostname}:${parsed.port}`
  } catch {
    return proxyUrl
  }
}

function entrySignature(entry: WebshareProxyEntry): string {
  return JSON.stringify([entry.id, entry.name, entry.proxyUrl, entry.enabled, entry.sourceKeyId ?? ''])
}

/**
 * Pull every stored key's Proxy List and merge the exits into the persisted
 * pool. Safe to call concurrently: overlaps are ignored.
 */
export async function syncWebsharePoolNow(reason: string): Promise<WebshareSyncSnapshot> {
  if (syncState.syncing) return webshareSyncSnapshot()
  const config = persistedConfig()
  const keys = config?.apiKeys ?? []
  if (keys.length === 0) return webshareSyncSnapshot()
  syncState.syncing = true
  try {
    const lists = await Promise.all(
      keys.map(async (key) => {
        try {
          return { key, items: await fetchKeyList(key.apiKey), error: '' }
        } catch (error) {
          return { key, items: [] as WebshareProxyListItem[], error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    const keyedHostPorts = new Set<string>()
    const supersededByHostPort = new Map<string, WebshareProxyEntry>()
    for (const { items, error } of lists) {
      if (error) continue
      for (const item of items) keyedHostPorts.add(`${item.ipAddress}:${item.port}`)
    }

    const current = persistedConfig() ?? config ?? { enabled: false, proxyUrl: '' }
    const existing = current.entries ?? []
    const stateByUrl = new Map<string, WebshareProxyEntry>()
    for (const entry of existing) stateByUrl.set(entry.proxyUrl, entry)
    const keyIds = new Set(keys.map(key => key.id))
    const merged: WebshareProxyEntry[] = []
    const claimed = new Set<string>()
    // Manual entries (no owning key) keep their place; keyed entries are
    // re-materialized from the live lists below.
    for (const entry of existing) {
      if (entry.sourceKeyId && keyIds.has(entry.sourceKeyId)) continue
      // A manual entry whose exit is now owned by a key is superseded by
      // the keyed entry (same IP:port; credentials come from the key list).
      if (!entry.sourceKeyId && keyedHostPorts.has(hostPortOf(entry.proxyUrl))) {
        supersededByHostPort.set(hostPortOf(entry.proxyUrl), entry)
        continue
      }
      merged.push(entry)
      claimed.add(entry.proxyUrl)
    }
    const errors: string[] = []
    for (const { key, items, error } of lists) {
      if (error) {
        errors.push(`${key.label || key.id}: ${error}`)
        // Keep this key's last known exits when its fetch failed.
        for (const entry of existing) {
          if (entry.sourceKeyId === key.id && !claimed.has(entry.proxyUrl)) {
            merged.push(entry)
            claimed.add(entry.proxyUrl)
          }
        }
        continue
      }
      for (const item of items) {
        const url = buildEntryUrl(item)
        const prev = stateByUrl.get(url) ?? supersededByHostPort.get(`${item.ipAddress}:${item.port}`)
        if (claimed.has(url)) {
          // A manual entry with the same URL is adopted by this key.
          const idx = merged.findIndex(candidate => candidate.proxyUrl === url)
          if (idx >= 0) merged[idx] = { ...merged[idx], sourceKeyId: key.id }
          continue
        }
        merged.push({
          id: prev?.id ?? generateWebshareEntryId(),
          name: prev?.name || `${item.countryName || item.country || 'proxy'} ${item.ipAddress}`,
          proxyUrl: url,
          enabled: prev?.enabled ?? true,
          lastUsed: prev?.lastUsed,
          cooldownUntil: prev?.cooldownUntil,
          failureCount: prev?.failureCount ?? 0,
          createdAt: prev?.createdAt ?? Date.now(),
          sourceKeyId: key.id,
        })
        claimed.add(url)
      }
    }
    syncState.lastSyncAt = Date.now()
    syncState.lastError = errors.join('; ')
    const changed =
      existing.length !== merged.length ||
      existing.some((entry, index) => entrySignature(entry) !== entrySignature(merged[index]))
    if (changed) {
      const next: WebshareProxyConfig = {
        ...current,
        entries: merged.length > 0 ? merged : undefined,
        rotationStrategy: current.rotationStrategy ?? 'round-robin',
      }
      ConfigManager.update({ webshareProxyConfig: next })
      setWebshareProxyConfig(
        { enabled: next.enabled, proxyUrl: next.proxyUrl },
        next.entries,
        next.rotationStrategy,
      )
    }
    if (errors.length > 0) {
      console.warn('[WebsharePoolSync] sync finished with errors', JSON.stringify({ reason, errors }))
    } else {
      console.info('[WebsharePoolSync] pool synced', JSON.stringify({ reason, entries: merged.length, changed }))
    }
    return webshareSyncSnapshot()
  } finally {
    syncState.syncing = false
  }
}
