/**
 * Per-day account usage arithmetic.
 *
 * `todayUsed` used to be a bare increment of `requestCount` with no rollover,
 * so 总请求数 and 今日已用 were always the same number in the account list. The
 * counter is only meaningful with a day boundary, and that boundary has to be
 * the user's local midnight, not UTC's.
 */

/** Local calendar day key (`YYYY-MM-DD`). */
export function getLocalDayKey(timestamp: number = Date.now()): string {
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export interface DailyUsageFields {
  todayUsed?: number
  todayUsedDate?: string
}

/**
 * Record one request against an account, rolling the daily counter over when
 * the stored `todayUsedDate` is not today. A missing date key means the record
 * predates this field, so it is treated as stale rather than as "still today".
 */
export function applyDailyUsage(
  account: DailyUsageFields,
  now: number = Date.now()
): Required<DailyUsageFields> {
  const today = getLocalDayKey(now)
  const sameDay = account.todayUsedDate === today

  return {
    todayUsed: sameDay ? (account.todayUsed || 0) + 1 : 1,
    todayUsedDate: today,
  }
}

/** Zeroed daily usage for `now`'s day, used by the startup/manual reset paths. */
export function resetDailyUsage(now: number = Date.now()): Required<DailyUsageFields> {
  return { todayUsed: 0, todayUsedDate: getLocalDayKey(now) }
}
