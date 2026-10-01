/**
 * Copilot Studio agent provisioning (network side).
 *
 * Provisions one tool-calling agent per tenant and caches its id. Every failure
 * path returns null: the M365 request then proceeds on the existing fenced
 * protocol rather than breaking, because an agent that cannot be created must
 * not turn into "M365 does not work".
 *
 * Requires two scopes the ChatHub grant does not include:
 *   - https://api.powerplatform.com/.default  (Copilot Studio APIs)
 *   - https://api.bap.microsoft.com/.default   (environment discovery)
 * A tenant that has not consented to them gets a clear log line and the fenced
 * fallback. Off unless CHAT2API_M365_STUDIO_AGENT is on.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { deflateSync } from 'zlib'
import { refresh } from '../auth/token.ts'
import {
  BAP_API,
  BAP_ENVIRONMENTS_PATH,
  BAP_SCOPE,
  POWER_PLATFORM_SCOPE,
  PP_BOTS_PATH,
  PP_BOT_PUBLISH_PATH_SUFFIX,
  agentIdFrom,
  agentInstructions,
  agentInstructionsHash,
  agentName,
  parseEnvironmentIdFromName,
  powerPlatformEnvironmentUrl,
} from './agentIdentity.ts'

export interface StudioAgentConfig {
  enabled: boolean
  /** Injected for tests; production reads the account's stored refresh token. */
  getRefreshToken: () => string | undefined | Promise<string | undefined>
  cachePath: string
  timeoutMs: number
}

/**
 * Deployment knob. Default off: provisioning writes to the tenant, and nothing
 * in this repo verifies the tenant has consented to the two scopes.
 */
export function studioAgentEnabled(): boolean {
  const raw = String(process.env.CHAT2API_M365_STUDIO_AGENT ?? '').trim().toLowerCase()
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes'
}

export function studioAgentCachePath(dataDir: string): string {
  return `${dataDir.replace(/[/\\]+$/, '')}/m365-studio-agent.json`
}

export interface CachedAgentRecord {
  /** Empty when provisioning was attempted and failed; the route stays off. */
  agentId: string
  botId: string
  instructionsHash: string
  createdAt: string
  /** Tenant this record belongs to; a tenant switch must not reuse it. */
  tenantId?: string
  /** Why agentId is empty, for the operator-facing log. */
  unavailableReason?: string
}

function parseCache(raw: string | undefined): CachedAgentRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedAgentRecord
    // A record with no instructionsHash is an explicit NEGATIVE result
    // (provisioning attempted and failed). It must survive the parse, or the
    // caller would re-attempt the known-useless route on every tool turn.
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Remember that the route is unusable, so the token request is not repeated on
 * every tool turn. Overwritten as soon as a real agent is provisioned.
 */
function writeUnavailableCache(path: string, reason: string): void {
  writeCache(path, {
    agentId: '',
    botId: '',
    instructionsHash: agentInstructionsHash(),
    createdAt: new Date().toISOString(),
    unavailableReason: reason,
  })
}

function readCache(path: string): CachedAgentRecord | null {
  try {
    return parseCache(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeCache(path: string, record: CachedAgentRecord): void {
  try {
    const dir = path.replace(/[/\\][^/\\]+$/, '')
    if (dir) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(record, null, 2))
  } catch (error) {
    console.warn('[M365Copilot] could not cache the Studio agent id; it will be re-provisioned next start', error instanceof Error ? error.message : error)
  }
}

async function tokenFor(refreshToken: string, scope: string, timeoutMs: number): Promise<string | null> {
  try {
    // The stored grant is the sydney v2 set; asking for a different scope only
    // works where the tenant consented to it, and fails cleanly where it did
    // not (invalid_scope / interaction_required), which is what we want.
    const set = await Promise.race([
      refresh(refreshToken, undefined, scope),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('token request timed out')), timeoutMs)),
    ])
    return set?.accessToken ?? null
  } catch (error) {
    console.warn('[M365Copilot] could not acquire a token for the Studio agent scope', JSON.stringify({
      scope,
      error: error instanceof Error ? error.message : String(error),
    }))
    return null
  }
}

async function fetchJson(url: string, token: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; body: any; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-ms-user-agent': 'PVA-Portal/1.0.0 (Web; ReactNative: false)',
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    const text = await res.text()
    let body: any = undefined
    try { body = JSON.parse(text) } catch { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

async function discoverEnvironmentUrl(bapToken: string, timeoutMs: number): Promise<string | null> {
  const res = await fetchJson(`${BAP_API}${BAP_ENVIRONMENTS_PATH}`, bapToken, { method: 'GET' }, timeoutMs)
  if (!res.ok || !res.body) {
    console.warn('[M365Copilot] BAP environment discovery failed; staying on the fenced protocol', JSON.stringify({
      status: res.status,
      body: res.text.slice(0, 200),
    }))
    return null
  }
  const envId = parseEnvironmentIdFromName(typeof res.body.name === 'string' ? res.body.name : undefined)
  if (!envId) {
    console.warn('[M365Copilot] BAP returned an unrecognised environment name; staying on the fenced protocol', JSON.stringify({
      name: res.body.name,
    }))
    return null
  }
  return powerPlatformEnvironmentUrl(envId)
}

/**
 * A 48x48 opaque PNG, generated rather than pasted in.
 *
 * Publishing rejects a bot without an icon, so one has to be supplied. Encoding
 * it here keeps the module self-contained instead of carrying a base64 blob
 * copied from another project.
 */
function botIconBase64(): string {
  const size = 48
  // zlib deflate of a PNG IDAT: filter byte + RGB per row.
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const p = rowStart + 1 + x * 3
      raw[p] = 0x2b
      raw[p + 1] = 0x63
      raw[p + 2] = 0xd4
    }
  }
  const crcTable: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    // Index loop, not `for..of`: iterating a Buffer needs downlevelIteration,
    // which tsconfig.node.json does not enable.
    for (let index = 0; index < buf.length; index += 1) {
      c = crcTable[(c ^ buf[index]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

async function listBots(envUrl: string, ppToken: string, timeoutMs: number): Promise<Array<{ botId: string; shortBotName: string }>> {
  const res = await fetchJson(`${envUrl}${PP_BOTS_PATH}`, ppToken, { method: 'GET' }, timeoutMs)
  if (!res.ok) throw new Error(`listBots failed: ${res.status} ${res.text.slice(0, 200)}`)
  return Array.isArray(res.body) ? res.body : []
}

async function createBot(envUrl: string, ppToken: string, timeoutMs: number): Promise<string> {
  const name = agentName()
  const body = {
    botComponentChanges: [{
      component: {
        diagnostics: [],
        displayName: name,
        id: '00000000-0000-0000-0000-000000000000',
        metadata: {
          tools: [],
          conversationStarters: [],
          diagnostics: [],
          instructions: {
            $kind: 'TemplateLine',
            segments: [{ $kind: 'TextSegment', value: agentInstructions(), diagnostics: [] }],
            diagnostics: [],
          },
          knowledgeSources: { diagnostics: [], $kind: 'SearchAllKnowledgeSources' },
          $kind: 'GptComponentMetadata',
          gptCapabilities: {
            diagnostics: [],
            $kind: 'GptCapabilities',
            codeInterpreter: false,
            generateImages: false,
            webBrowsing: false,
            searchOneDriveAndSharePoint: false,
            searchTeams: false,
            searchMeetings: false,
            searchEmails: false,
            searchPeople: false,
          },
          aISettings: { diagnostics: [], $kind: 'AISettings', useModelKnowledge: true },
        },
        schemaName: '00000000-0000-0000-0000-000000000000.gpt.default',
        $kind: 'GptComponent',
        description: 'Auto-created agent for tool calling',
      },
      $kind: 'BotComponentInsert',
    }],
    cloudFlowDefinitionChanges: [],
    connectorDefinitionChanges: [],
    environmentVariableChanges: [],
    connectionReferenceChanges: [],
    aIPluginOperationChanges: [],
    componentCollectionChanges: [],
    dataverseTableSearchChanges: [],
    dataverseTableSearchEntityConfigurationChanges: [],
    dataverseTableSearchGlossaryConfigurationChanges: [],
    dataverseTableSearchEntityColumnSynonymChanges: [],
    aIModelChanges: [],
    connectedAgentDefinitionChanges: [],
    bot: {
      authorizedSecurityGroupIds: [],
      supportedLanguages: [],
      diagnostics: [],
      displayName: name,
      language: 1033,
      schemaName: '00000000-0000-0000-0000-000000000000',
      template: 'gpt-1.1.0',
      $kind: 'BotEntity',
      iconBase64: botIconBase64(),
    },
  }
  const res = await fetchJson(`${envUrl}${PP_BOTS_PATH}`, ppToken, { method: 'POST', body: JSON.stringify(body) }, timeoutMs)
  if (!res.ok) throw new Error(`createBot failed: ${res.status} ${res.text.slice(0, 200)}`)
  const botId = res.body?.bot?.schemaName || res.body?.bot?.cdsBotId
  if (typeof botId !== 'string' || !botId) throw new Error('createBot response carried no bot id')
  return botId
}

async function publishBot(envUrl: string, ppToken: string, botId: string, timeoutMs: number): Promise<string> {
  const res = await fetchJson(`${envUrl}${PP_BOTS_PATH}/${botId}${PP_BOT_PUBLISH_PATH_SUFFIX}`, ppToken, { method: 'POST' }, timeoutMs)
  if (!res.ok) throw new Error(`publishBot failed: ${res.status} ${res.text.slice(0, 200)}`)
  return res.body?.TitleId
}

/**
 * Resolve the agent id to reference for a tool-bearing turn, provisioning one
 * on first use. Returns null whenever anything is unavailable, which leaves the
 * caller on the fenced protocol.
 */
export async function getOrCreateStudioAgent(config: StudioAgentConfig): Promise<string | null> {
  if (!config.enabled) return null
  const wantHash = agentInstructionsHash()

  const cached = readCache(config.cachePath)
  if (cached && cached.instructionsHash === wantHash) return cached.agentId
  if (cached) {
    console.log('[M365Copilot] cached Studio agent instructions are stale; re-provisioning', JSON.stringify({
      cached: cached.instructionsHash,
      want: wantHash,
    }))
  }

  const refreshToken = await config.getRefreshToken()
  if (!refreshToken) {
    console.warn('[M365Copilot] no refresh token available; the Studio agent is unavailable and tool turns stay on the fenced protocol')
    return null
  }

  const bapToken = await tokenFor(refreshToken, BAP_SCOPE, config.timeoutMs)
  if (!bapToken) {
    writeUnavailableCache(config.cachePath, 'no token for the BAP scope (tenant has not consented, or the account type does not offer it)')
    return null
  }
  const envUrl = await discoverEnvironmentUrl(bapToken, config.timeoutMs)
  if (!envUrl) {
    writeUnavailableCache(config.cachePath, 'BAP environment discovery failed')
    return null
  }
  const ppToken = await tokenFor(refreshToken, POWER_PLATFORM_SCOPE, config.timeoutMs)
  if (!ppToken) {
    writeUnavailableCache(config.cachePath, 'no token for the Power Platform scope')
    return null
  }

  try {
    const wantName = agentName()
    const bots = await listBots(envUrl, ppToken, config.timeoutMs)
    const existing = bots.find((bot) => bot.shortBotName === wantName)
    // Instructions are baked in by create, so an existing bot is only reusable
    // when the name (and therefore the hash) matches.
    const botId = existing?.botId ?? await createBot(envUrl, ppToken, config.timeoutMs)
    const titleId = await publishBot(envUrl, ppToken, botId, config.timeoutMs)
    const agentId = agentIdFrom(titleId, botId)
    // Older agents are intentionally LEFT in place, never deleted: a second
    // proxy sharing this tenant may still hold a conversation with one.
    writeCache(config.cachePath, {
      agentId,
      botId,
      instructionsHash: wantHash,
      createdAt: new Date().toISOString(),
    })
    console.log('[M365Copilot] Studio agent ready', JSON.stringify({ agentId, reused: Boolean(existing) }))
    return agentId
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('[M365Copilot] Studio agent provisioning failed; staying on the fenced protocol', JSON.stringify({ error: reason }))
    writeUnavailableCache(config.cachePath, reason.slice(0, 300))
    return null
  }
}
