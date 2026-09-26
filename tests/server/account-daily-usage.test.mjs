import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  applyDailyUsage,
  getLocalDayKey,
  resetDailyUsage,
} from '../../src/main/store/dailyUsage.ts'

// 2026-09-26 local time, chosen so the UTC day is a different calendar day for
// most of the world: a UTC rollover would reset the counter on the wrong day.
const DAY_MORNING = new Date(2026, 8, 26, 10, 0, 0).getTime()
const NEXT_DAY_MORNING = new Date(2026, 8, 27, 10, 0, 0).getTime()
const NEXT_YEAR = new Date(2027, 0, 1, 10, 0, 0).getTime()

test('daily counter increments within the same local day', () => {
  const first = applyDailyUsage({}, DAY_MORNING)
  assert.equal(first.todayUsed, 1)
  assert.equal(first.todayUsedDate, getLocalDayKey(DAY_MORNING))

  const second = applyDailyUsage(first, DAY_MORNING + 60_000)
  assert.equal(second.todayUsed, 2)
  assert.equal(second.todayUsedDate, first.todayUsedDate)
})

test('daily counter resets at the local day boundary instead of matching the total', () => {
  const yesterday = applyDailyUsage({}, DAY_MORNING)
  let account = { todayUsed: yesterday.todayUsed, todayUsedDate: yesterday.todayUsedDate }
  let totalRequests = yesterday.todayUsed

  for (let i = 0; i < 5; i++) {
    account = applyDailyUsage(account, NEXT_DAY_MORNING)
    totalRequests += 1
  }

  assert.equal(account.todayUsed, 5, 'today counter is per day')
  assert.equal(totalRequests, 6, 'lifetime counter keeps growing')
  assert.notEqual(account.todayUsed, totalRequests)
  assert.equal(account.todayUsedDate, getLocalDayKey(NEXT_DAY_MORNING))
})

test('a missing day key is treated as stale, not as today', () => {
  const result = applyDailyUsage({ todayUsed: 906 }, DAY_MORNING)
  assert.equal(result.todayUsed, 1)
  assert.equal(result.todayUsedDate, getLocalDayKey(DAY_MORNING))
})

test('month and year rollovers are not skipped', () => {
  const lastDayOfYear = new Date(2026, 11, 31, 23, 59, 0).getTime()
  const next = applyDailyUsage({ todayUsed: 4, todayUsedDate: getLocalDayKey(lastDayOfYear) }, NEXT_YEAR)
  assert.equal(next.todayUsed, 1)
  assert.equal(next.todayUsedDate, getLocalDayKey(NEXT_YEAR))
  assert.equal(getLocalDayKey(NEXT_YEAR), '2027-01-01')
})

test('day key uses local time, not UTC', () => {
  const localEvening = new Date(2026, 8, 26, 23, 30, 0).getTime()
  assert.equal(getLocalDayKey(localEvening), '2026-09-26')
  assert.equal(getLocalDayKey(localEvening).length, 10)
})

test('reset zeroes the counter and stamps today', () => {
  const result = resetDailyUsage(DAY_MORNING)
  assert.equal(result.todayUsed, 0)
  assert.equal(result.todayUsedDate, getLocalDayKey(DAY_MORNING))
})

test('store rolls the daily counter over on startup and on increment', () => {
  const store = fs.readFileSync('src/main/store/store.ts', 'utf8')

  assert.match(store, /private rollOverDailyUsage\(now: number = Date\.now\(\)\)/)
  assert.match(store, /this\.rollOverDailyUsage\(\)/, 'startup path must call the rollover')
  assert.match(store, /\.\.\.applyDailyUsage\(current, now\)/)

  // The manual increments that bypassed the rollover are the reason the two
  // numbers were identical; make sure none come back.
  for (const file of [
    'src/main/store/accounts.ts',
    'src/main/proxy/routes/completions.ts',
  ]) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(
      source,
      /todayUsed:\s*\([^)]*\) \+ 1/,
      `${file} increments todayUsed without a day rollover`
    )
  }

  assert.match(
    fs.readFileSync('src/main/store/accounts.ts', 'utf8'),
    /static incrementRequestCount\(id: string\): void \{\s*storeManager\.incrementAccountUsage\(id\)/
  )
  assert.match(
    fs.readFileSync('src/main/proxy/routes/completions.ts', 'utf8'),
    /storeManager\.incrementAccountUsage\(account\.id\)/
  )
})
