/**
 * Process-wide circuit breaker for Z.ai captcha solving.
 *
 * Aliyun scores captcha outcomes per EGRESS, not per account: every failed
 * drag or risk-blocked verify (F001/F015) raises the exit IP's risk score, and
 * past a threshold the WAF stops challenging and starts blocking chat POSTs
 * outright (HTTP 405). Observed live 2026-09-29: ~48 solves in 50 minutes, a
 * large share of them F001/F015 while the solver still ran headless, and the
 * home residential IP moved from "challenged" to "blocked" at 16:10 UTC for
 * hours. Rotating accounts cannot help because they all share the exit, and
 * retrying immediately only feeds the score - the same failure mode the Qwen
 * x5sec refresh guards against with its 3-per-15-min trigger and cooldown.
 *
 * Contract: after `threshold` consecutive failures (any account, chat-captcha
 * or login-captcha) the breaker opens and every solve is refused without
 * launching a browser. After the cooldown one probe solve is allowed
 * (half-open); success closes the breaker, failure reopens it with the
 * cooldown doubled up to the cap. Any success resets the failure streak.
 *
 * Leaf module with no runtime deps so node --test can load it directly.
 */

export interface ZaiCaptchaBreakerConfig {
  /** Consecutive failures that open the breaker; 0 disables it. */
  threshold: number
  cooldownMs: number
  maxCooldownMs: number
}

export type ZaiCaptchaBreakerDecision =
  | { allowed: true; probe: boolean }
  | { allowed: false; retryInMs: number; consecutiveFailures: number }

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function zaiCaptchaBreakerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ZaiCaptchaBreakerConfig {
  const cooldownMs = envInt(env.CHAT2API_ZAI_CAPTCHA_BREAKER_COOLDOWN_MS, 15 * 60_000, 1_000, 24 * 3_600_000)
  return {
    threshold: envInt(env.CHAT2API_ZAI_CAPTCHA_BREAKER_THRESHOLD, 3, 0, 1_000),
    cooldownMs,
    maxCooldownMs: Math.max(
      cooldownMs,
      envInt(env.CHAT2API_ZAI_CAPTCHA_BREAKER_MAX_COOLDOWN_MS, 60 * 60_000, 1_000, 24 * 3_600_000),
    ),
  }
}

export class ZaiCaptchaBreaker {
  private consecutiveFailures = 0
  private openUntil = 0
  private currentCooldownMs = 0
  private probeInFlight = false
  private readonly config: () => ZaiCaptchaBreakerConfig
  private readonly now: () => number

  constructor(
    config: () => ZaiCaptchaBreakerConfig = () => zaiCaptchaBreakerConfigFromEnv(),
    now: () => number = () => Date.now(),
  ) {
    this.config = config
    this.now = now
  }

  /** Ask before launching a solver browser. */
  tryAcquire(): ZaiCaptchaBreakerDecision {
    const { threshold } = this.config()
    if (threshold <= 0) return { allowed: true, probe: false }
    if (this.openUntil === 0) return { allowed: true, probe: false }
    const now = this.now()
    if (now < this.openUntil || this.probeInFlight) {
      return {
        allowed: false,
        retryInMs: Math.max(0, this.openUntil - now),
        consecutiveFailures: this.consecutiveFailures,
      }
    }
    // Half-open: exactly one probe solve until it reports back.
    this.probeInFlight = true
    return { allowed: true, probe: true }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.openUntil = 0
    this.currentCooldownMs = 0
    this.probeInFlight = false
  }

  /** Returns true when this failure opened (or re-opened) the breaker. */
  recordFailure(): boolean {
    const { threshold, cooldownMs, maxCooldownMs } = this.config()
    this.consecutiveFailures += 1
    const wasProbe = this.probeInFlight
    this.probeInFlight = false
    if (threshold <= 0) return false
    if (!wasProbe && this.consecutiveFailures < threshold) return false
    this.currentCooldownMs = wasProbe && this.currentCooldownMs > 0
      ? Math.min(maxCooldownMs, this.currentCooldownMs * 2)
      : cooldownMs
    this.openUntil = this.now() + this.currentCooldownMs
    return true
  }

  /** A solve that was allowed but never reached a verdict (e.g. aborted). */
  releaseProbe(): void {
    this.probeInFlight = false
  }

  snapshot(): { consecutiveFailures: number; openUntil: number; cooldownMs: number } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      openUntil: this.openUntil,
      cooldownMs: this.currentCooldownMs,
    }
  }
}

/** Shared by the chat-captcha solver and the credential re-login. */
export const zaiCaptchaBreaker = new ZaiCaptchaBreaker()
