const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** Zero disables periodic refresh; startup/manual synchronization still works. */
export function modelCatalogueRefreshIntervalMsFromEnv(): number {
  const raw = process.env.CHAT2API_MODEL_CATALOGUE_REFRESH_INTERVAL_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_REFRESH_INTERVAL_MS
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : DEFAULT_REFRESH_INTERVAL_MS
}

/** Shared by desktop and headless proxy lifecycles; never overlaps network polls. */
export class ModelCatalogueRefreshService {
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined

  constructor(private readonly synchronize: () => Promise<void>) {}

  start(): void {
    if (this.timer) return
    const intervalMs = modelCatalogueRefreshIntervalMsFromEnv()
    if (intervalMs === 0) return
    this.timer = setInterval(() => { void this.refresh() }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = Promise.resolve()
      .then(() => this.synchronize())
      .catch(error => {
        console.warn('[Models] Periodic catalogue refresh failed; retaining persisted models', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
}
