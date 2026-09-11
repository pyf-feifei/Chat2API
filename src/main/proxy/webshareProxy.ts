import { HttpsProxyAgent } from 'https-proxy-agent'

/**
 * Webshare proxy integration for RGV587 risk-control recovery.
 *
 * RGV587 is IP-level risk control: rotating accounts cannot escape it
 * because every account leaves from the same flagged exit IP. When
 * enabled, the Qwen forwarder retries a request rejected with the
 * RGV587 busy envelope through the configured Webshare proxy, so the
 * retry leaves from a different exit IP. Ordinary traffic never uses
 * the proxy; only this recovery path does, keeping proxy bandwidth
 * minimal.
 *
 * Two configuration shapes, both applied at runtime (management UI):
 *  - Single proxy: `enabled` + `proxyUrl`.
 *  - Key pool: `entries[]` (each entry's proxyUrl is one Webshare key
 *    = one exit) with a rotation strategy. The pool takes precedence
 *    over the single URL when it has at least one enabled entry.
 *
 * Rotation:
 *  - round-robin: step through enabled, non-cooled entries in order.
 *  - random: pick uniformly among enabled, non-cooled entries.
 *  - failover: always use the first healthy entry; a failure cools it
 *    and moves traffic to the next (sticky — recovers back to the
 *    preferred entry when its cooldown expires).
 *
 * Failure accounting: every recovery failure cools the used entry for
 * COOLDOWN_MS (doubling per consecutive failure, capped); a success
 * clears the failure counter. The single-URL shape stays on the old
 * no-cooldown behavior.
 *
 * Environment fallback (CHAT2API_ prefixed names take precedence):
 *   WEBSHARE_PROXY_ENABLED - 'true' or '1' enables the recovery (default off)
 *   WEBSHARE_PROXY_URL     - Full proxy URL, e.g. http://user:pass@proxy.webshare.io:8080
 */

const WEBSHARE_ENTRY_COOLDOWN_BASE_MS = 60_000
const WEBSHARE_ENTRY_COOLDOWN_MAX_MS = 30 * 60_000
/** Doubling backoff per consecutive failure, capped. */
const WEBSHARE_ENTRY_COOLDOWN_BACKOFF_FACTOR = 2

/**
 * Sticky mode (mode B): once a recovery retry proves the direct exit IP
 * is risk-controlled (the proxy retry succeeds where direct failed), ALL
 * Qwen traffic stays on the proxy instead of paying the recovery tax per
 * request. A background direct probe (qwen.ai homepage HEAD, no account
 * involved) re-tests the direct IP; when it stops looking risk-controlled,
 * traffic reverts to direct automatically. A probe that fails to even
 * connect is inconclusive and never triggers the switch-back.
 */
const WEBSHARE_DIRECT_PROBE_URL = 'https://www.qwen.ai/'
const WEBSHARE_DIRECT_PROBE_INTERVAL_MS = 60_000
const WEBSHARE_DIRECT_PROBE_STICKY_LOG_INTERVAL_MS = 10 * 60_000

export interface WebshareProxyRuntimeConfig {
  enabled: boolean
  proxyUrl: string
}

interface PoolEntryState {
  proxyUrl: string
  enabled: boolean
  cooldownUntil: number
  failureCount: number
  lastUsed?: number
  /** Owning dashboard key (key-pool sync); groups exits for key-level verdicts. */
  sourceKeyId?: string
}

let configured: WebshareProxyRuntimeConfig | undefined
let poolEntries: PoolEntryState[] = []
let rotationStrategy: 'round-robin' | 'random' | 'failover' = 'round-robin'
let roundRobinIndex = 0
const agentCache = new Map<string, HttpsProxyAgent<string>>()

/** Sticky mode state: guarded by a getter/setter so tests can observe it. */
interface WebshareStickyState {
  /** All Qwen traffic routes through the proxy until the direct IP recovers. */
  active: boolean
  /** When the sticky state last flipped (ms epoch), for status display. */
  since: number
  /** Last switch reason, surfaced in the management status payload. */
  reason: string
  /** In-flight direct probe guard. */
  probing: boolean
  /** Next direct probe due (ms epoch). */
  nextProbeAt: number
  /** Number of consecutive direct probes that passed since going sticky. */
  passedProbes: number
}

const stickyState: WebshareStickyState = {
  active: false,
  since: 0,
  reason: '',
  probing: false,
  nextProbeAt: 0,
  passedProbes: 0,
}

function webshareProxyUrlFromEnv(): string | undefined {
  const raw = (process.env.CHAT2API_WEBSHARE_PROXY_URL || process.env.WEBSHARE_PROXY_URL || '').trim()
  return raw || undefined
}

function webshareEnabledFromEnv(): boolean {
  const enabled = (
    process.env.CHAT2API_WEBSHARE_PROXY_ENABLED
    || process.env.WEBSHARE_PROXY_ENABLED
    || ''
  ).trim().toLowerCase()
  return enabled === 'true' || enabled === '1'
}

/**
 * Runtime override from the persisted management config. Passing
 * undefined restores env-only behavior (used when the config section is
 * absent so deployments keep their env-driven behavior).
 *
 * `entries` (when non-empty) takes precedence over `proxyUrl`: the pool
 * owns rotation and cooldown state in-memory; callers persist the
 * observable fields (lastUsed/cooldownUntil/failureCount) via
 * websharePoolSnapshot().
 */
export function setWebshareProxyConfig(
  config: WebshareProxyRuntimeConfig | undefined,
  entries?: Array<{
    proxyUrl: string
    enabled?: boolean
    failureCount?: number
    lastUsed?: number
    cooldownUntil?: number
    sourceKeyId?: string
  }>,
  strategy?: 'round-robin' | 'random' | 'failover',
): void {
  configured = config
  const now = Date.now()
  poolEntries = (entries ?? [])
    .filter(entry => Boolean(entry?.proxyUrl))
    .map(entry => ({
      proxyUrl: entry.proxyUrl.trim(),
      enabled: entry.enabled !== false,
      // A persisted cooldown that already expired is dropped on re-apply.
      cooldownUntil: typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now
        ? entry.cooldownUntil
        : 0,
      failureCount: Math.max(0, Math.floor(entry.failureCount ?? 0)),
      lastUsed: entry.lastUsed,
      sourceKeyId: entry.sourceKeyId?.trim() || undefined,
    }))
  rotationStrategy = strategy === 'random' || strategy === 'failover' ? strategy : 'round-robin'
  // Failover prefers the first entry; a pool rebuilt from persisted
  // state keeps the original order, which is the preference order.
  roundRobinIndex = 0
}

export function webshareProxyConfigSnapshot(): WebshareProxyRuntimeConfig | undefined {
  return configured ? { ...configured } : undefined
}

/** Observable pool state for persistence and the management status. */
export function websharePoolSnapshot(): Array<{
  proxyUrl: string
  enabled: boolean
  cooldownUntil: number
  failureCount: number
  lastUsed?: number
  sourceKeyId?: string
}> {
  return poolEntries.map(entry => ({ ...entry }))
}

function effectiveConfig(): { enabled: boolean; proxyUrl: string | undefined } {
  if (configured) {
    return {
      enabled: Boolean(configured.enabled),
      proxyUrl: configured.proxyUrl.trim() || undefined,
    }
  }
  return {
    enabled: webshareEnabledFromEnv(),
    proxyUrl: webshareProxyUrlFromEnv(),
  }
}

export function isWebshareProxyEnabled(): boolean {
  const { enabled } = effectiveConfig()
  if (!enabled) return false
  return poolEntries.length > 0 || Boolean(webshareActiveProxyUrl())
}

function healthyPoolEntries(now = Date.now()): PoolEntryState[] {
  return poolEntries.filter(entry => entry.enabled && entry.cooldownUntil <= now)
}

/**
 * The next pool exit. `failover` sticks to the first healthy entry;
 * `round-robin` steps; `random` picks. Falls back to any enabled
 * entry (even cooled) when every entry is cooling — a stale exit is
 * better than no exit for a one-shot recovery retry.
 */
function nextPoolProxyUrl(now = Date.now()): string | undefined {
  if (poolEntries.length === 0) return undefined
  const healthy = healthyPoolEntries(now)
  if (healthy.length === 0) {
    const anyEnabled = poolEntries.filter(entry => entry.enabled)
    if (anyEnabled.length === 0) return undefined
    return anyEnabled[0].proxyUrl
  }
  if (rotationStrategy === 'failover') return healthy[0].proxyUrl
  if (rotationStrategy === 'random') {
    return healthy[Math.floor(Math.random() * healthy.length)].proxyUrl
  }
  const index = roundRobinIndex % healthy.length
  roundRobinIndex = (roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER
  return healthy[index].proxyUrl
}

function webshareActiveProxyUrl(): string | undefined {
  if (poolEntries.length > 0) {
    const url = nextPoolProxyUrl()
    if (url) {
      webshareLastProxyUrl = url
      // Stamp lastUsed at selection time so rotation is observable (UI
      // "last used", pool persistence, and failure attribution) even
      // when a request never completes to call reportWebshareProxySuccess.
      const entry = poolEntries.find(candidate => candidate.proxyUrl === url)
      if (entry) stampLastUsed(entry)
    }
    return url
  }
  const single = effectiveConfig().proxyUrl
  if (single) webshareLastProxyUrl = single
  return single
}

/**
 * Record a completed use: clears the entry's failure counter and
 * stamps lastUsed. No-op for the single-URL shape.
 */
export function reportWebshareProxySuccess(proxyUrl?: string): void {
  const url = proxyUrl ?? webshareLastProxyUrl
  if (!url) return
  const entry = poolEntries.find(candidate => candidate.proxyUrl === url)
  if (!entry) return
  entry.failureCount = 0
  entry.cooldownUntil = 0
  stampLastUsed(entry)
}

/** Doubling cooldown so a bad exit stops receiving recovery traffic quickly. */
function coolEntryForFailure(entry: PoolEntryState): void {
  entry.failureCount += 1
  const backoff = Math.min(
    WEBSHARE_ENTRY_COOLDOWN_MAX_MS,
    WEBSHARE_ENTRY_COOLDOWN_BASE_MS * (WEBSHARE_ENTRY_COOLDOWN_BACKOFF_FACTOR ** (entry.failureCount - 1)),
  )
  entry.cooldownUntil = Date.now() + backoff
}

/**
 * Record a failure for the entry matching `proxyUrl` (or the last one
 * handed out): doubling cooldown so a bad exit stops receiving
 * recovery traffic quickly. No-op for the single-URL shape.
 */
export function reportWebshareProxyFailure(proxyUrl?: string): void {
  const url = proxyUrl ?? webshareLastProxyUrl
  if (!url) return
  const entry = poolEntries.find(candidate => candidate.proxyUrl === url)
  if (!entry) return
  coolEntryForFailure(entry)
}

/**
 * Bandwidth exhaustion (HTTP 402 from the webshare edge) is a per-key
 * account verdict: every exit of the same dashboard key shares the
 * drained quota, so cool them all — otherwise rotation rediscovers the
 * drained key one 402 at a time through its remaining "healthy" exits
 * (observed live 2026-09-12 02:30 CN: two exits of one key 402'd back
 * to back before round-robin landed on a healthy key).
 */
export function reportWebshareKeyBandwidthExhausted(proxyUrl?: string): void {
  const url = proxyUrl ?? webshareLastProxyUrl
  if (!url) return
  const entry = poolEntries.find(candidate => candidate.proxyUrl === url)
  if (!entry) return
  const keyExits = entry.sourceKeyId
    ? poolEntries.filter(candidate => candidate.sourceKeyId === entry.sourceKeyId)
    : [entry]
  for (const exit of keyExits) coolEntryForFailure(exit)
  console.warn('[WebshareProxy] bandwidth 402 — cooled every exit of the drained key', JSON.stringify({
    sourceKeyId: entry.sourceKeyId ?? '(unkeyed exit)',
    cooledExits: keyExits.length,
    poolExits: poolEntries.length,
  }))
}

let webshareLastProxyUrl: string | undefined
/**
 * Monotonic stamp for lastUsed: guarantees each selection is strictly
 * newer than the previous one even when many pulls land in the same
 * millisecond, so "most recently used entry" is always well-defined.
 */
let webshareLastUsedClock = 0

function stampLastUsed(entry: PoolEntryState): void {
  webshareLastUsedClock = Math.max(webshareLastUsedClock + 1, Date.now())
  entry.lastUsed = webshareLastUsedClock
}

export interface WebshareProxyAgentCheckout {
  agent: HttpsProxyAgent<string>
  /** The exit this agent leaves through — the attribution anchor for success/failure reports. */
  proxyUrl: string
}

/**
 * Select the next pool exit and hand back the agent TOGETHER with the exit
 * URL, atomically. Callers that need to attribute a success/failure to the
 * exit they actually used must check out once and reuse the pair: the plain
 * `getWebshareProxyAgent()` selects on every call, so two calls in one
 * request can leave through different exits and misattribute the outcome
 * (the zai adapter used to evaluate it twice per request for exactly this
 * reason).
 */
export function checkoutWebshareProxyAgent(): WebshareProxyAgentCheckout | undefined {
  if (!isWebshareProxyEnabled()) return undefined
  const proxyUrl = webshareActiveProxyUrl()
  if (!proxyUrl) return undefined
  webshareLastProxyUrl = proxyUrl
  let agent = agentCache.get(proxyUrl)
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl)
    agentCache.set(proxyUrl, agent)
  }
  return { agent, proxyUrl }
}

export function getWebshareProxyAgent(): HttpsProxyAgent<string> | undefined {
  return checkoutWebshareProxyAgent()?.agent
}

/**
 * Read-only preview of the next pool exit WITHOUT advancing rotation state
 * or the last-used marker. Status/observability callers must not perturb the
 * live pool: a GET /config between two requests would otherwise move the
 * round-robin cursor and redirect failure attribution to the wrong entry
 * (observed 2026-09-09: management status polling reset failure accounting).
 */
function peekPoolProxyUrl(now = Date.now()): string | undefined {
  if (poolEntries.length === 0) return undefined
  const healthy = healthyPoolEntries(now)
  if (healthy.length === 0) {
    const anyEnabled = poolEntries.filter(entry => entry.enabled)
    if (anyEnabled.length === 0) return undefined
    return anyEnabled[0].proxyUrl
  }
  if (rotationStrategy === 'failover') return healthy[0].proxyUrl
  if (rotationStrategy === 'random') return healthy[0].proxyUrl
  return healthy[roundRobinIndex % healthy.length].proxyUrl
}

/**
 * Read-only log/status URL: previews the next exit without consuming
 * rotation state.
 */
export function webshareProxyUrlForLog(): string | undefined {
  if (poolEntries.length > 0) {
    const proxyUrl = peekPoolProxyUrl()
    return proxyUrl ? redactProxyUrl(proxyUrl) : undefined
  }
  const single = effectiveConfig().proxyUrl
  return single ? redactProxyUrl(single) : undefined
}

function redactProxyUrl(proxyUrl: string): string {
  return proxyUrl
}

// ---------------------------------------------------------------------------
// Sticky mode (mode B)
// ---------------------------------------------------------------------------

/** Observable sticky-mode snapshot for the management status and tests. */
export function webshareStickySnapshot(): {
  active: boolean
  since: number
  reason: string
  nextProbeAt: number
  passedProbes: number
} {
  return {
    active: stickyState.active,
    since: stickyState.since,
    reason: stickyState.reason,
    nextProbeAt: stickyState.nextProbeAt,
    passedProbes: stickyState.passedProbes,
  }
}

/** Test hook: force-clear sticky state between tests. */
export function resetWebshareStickyState(): void {
  stickyState.active = false
  stickyState.since = 0
  stickyState.reason = ''
  stickyState.probing = false
  stickyState.nextProbeAt = 0
  stickyState.passedProbes = 0
}

/**
 * Enter sticky mode. Called when a proxy-routed attempt succeeds after a
 * direct RGV587 failure — proof that the direct exit IP is risk-controlled
 * while the proxy exit works. Idempotent; re-entering refreshes `since`.
 */
export function engageWebshareStickyMode(reason: string, now = Date.now()): void {
  const wasActive = stickyState.active
  stickyState.active = true
  stickyState.since = now
  stickyState.reason = reason
  stickyState.passedProbes = 0
  stickyState.nextProbeAt = now + WEBSHARE_DIRECT_PROBE_INTERVAL_MS
  if (!wasActive) {
    console.warn('[WebshareProxy] sticky mode engaged — all Qwen traffic now routes through the proxy', JSON.stringify({
      reason,
      since: new Date(now).toISOString(),
      probeIntervalMs: WEBSHARE_DIRECT_PROBE_INTERVAL_MS,
    }))
  }
}

/** Manually leave sticky mode (management action or success-based confidence). */
export function disengageWebshareStickyMode(reason: string, now = Date.now()): void {
  if (!stickyState.active) return
  stickyState.active = false
  stickyState.since = 0
  stickyState.reason = ''
  stickyState.passedProbes = 0
  stickyState.nextProbeAt = 0
  console.info('[WebshareProxy] sticky mode disengaged — Qwen traffic back to the direct exit', JSON.stringify({
    reason,
    at: new Date(now).toISOString(),
  }))
}

/**
 * Whether the next Qwen request should leave through the proxy under sticky
 * mode. Exposed separately from `isWebshareProxyEnabled` (which reports the
 * *configuration*); this reports the *runtime traffic decision*.
 */
export function isWebshareStickyActive(): boolean {
  return stickyState.active && isWebshareProxyEnabled()
}

/**
 * RGV587 heuristic on the direct probe response: Qwen's risk control serves
 * the busy/verify envelope over HTTP 200/429/403 with these markers. A probe
 * that returns any other shape (e.g. a normal 200 homepage, a redirect, or
 * a 5xx outage) does NOT prove recovery — only absence of risk-control
 * markers on a reachable response does.
 */
function directProbeLooksRiskControlled(status: number, body: string): boolean {
  if (status !== 200 && status !== 403 && status !== 429) return false
  return /RGV587|FAIL_SYS_USER_VALIDATE|qwen_ai_risk_control|bxpunish|x5sec|baxia/i.test(body)
}

/**
 * Probe the direct exit IP (no proxy, no account). Returns true when the
 * direct IP looks healthy again. Transport failures are inconclusive →
 * false (stay sticky), which is the safe direction: sticky mode only costs
 * proxy bandwidth, while a premature switch-back costs request failures.
 */
async function probeDirectExit(): Promise<{ recovered: boolean; detail: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(WEBSHARE_DIRECT_PROBE_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chat2API-Probe' },
    })
    const body = response.status === 200 ? await response.text().catch(() => '') : ''
    if (directProbeLooksRiskControlled(response.status, body)) {
      return { recovered: false, detail: `risk-control markers on status ${response.status}` }
    }
    return { recovered: true, detail: `status ${response.status}` }
  } catch (error) {
    return {
      recovered: false,
      detail: `probe transport failure: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Direct-IP recovery probe, called opportunistically from the forwarder
 * when sticky mode is active and the next probe is due. Runs off the request
 * path (fire-and-forget) so a slow probe never delays a forwarded request.
 */
export function maybeProbeWebshareDirectExit(): void {
  if (!stickyState.active || stickyState.probing) return
  const now = Date.now()
  if (now < stickyState.nextProbeAt) return
  stickyState.probing = true
  void probeDirectExit().then(({ recovered, detail }) => {
    stickyState.probing = false
    const probedAt = Date.now()
    if (!recovered) {
      stickyState.passedProbes = 0
      stickyState.nextProbeAt = probedAt + WEBSHARE_DIRECT_PROBE_INTERVAL_MS
      if (probedAt - stickyState.since > WEBSHARE_DIRECT_PROBE_STICKY_LOG_INTERVAL_MS) {
        stickyState.since = probedAt - WEBSHARE_DIRECT_PROBE_STICKY_LOG_INTERVAL_MS
        console.info('[WebshareProxy] direct exit still risk-controlled, staying sticky', JSON.stringify({
          detail,
          since: new Date(stickyState.since).toISOString(),
        }))
      }
      return
    }
    stickyState.passedProbes += 1
    stickyState.nextProbeAt = probedAt + WEBSHARE_DIRECT_PROBE_INTERVAL_MS
    // Two consecutive clean probes guard against a flapping moment of
    // grace on the flagged IP.
    if (stickyState.passedProbes >= 2) {
      disengageWebshareStickyMode(`direct probe recovered (${detail}, 2 consecutive clean probes)`, probedAt)
    }
  }).catch(() => {
    stickyState.probing = false
  })
}
