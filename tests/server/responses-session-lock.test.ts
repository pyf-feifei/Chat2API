import assert from 'node:assert/strict'
import test from 'node:test'
import { ResponsesSessionLock } from '../../src/main/proxy/responses/sessionLock.ts'

test('Responses session lock serializes the same lineage but not different lineages', async () => {
  const lock = new ResponsesSessionLock()
  const firstRelease = await lock.acquire('resp_same')
  let secondAcquired = false
  const second = lock.acquire('resp_same').then((release) => {
    secondAcquired = true
    return release
  })
  const otherRelease = await lock.acquire('resp_other')
  assert.equal(secondAcquired, false)
  assert.equal(lock.activeKeys(), 2)

  otherRelease()
  firstRelease()
  const secondRelease = await second
  assert.equal(secondAcquired, true)
  secondRelease()
  assert.equal(lock.activeKeys(), 0)
})

test('Responses session lock removes an aborted waiter', async () => {
  const lock = new ResponsesSessionLock()
  const release = await lock.acquire('resp_abort')
  const controller = new AbortController()
  const waiting = lock.acquire('resp_abort', controller.signal)
  controller.abort()
  await assert.rejects(waiting, (error: Error & { code?: string }) => (
    error.name === 'AbortError' && error.code === 'responses_session_lock_aborted'
  ))
  release()
  assert.equal(lock.activeKeys(), 0)
})
