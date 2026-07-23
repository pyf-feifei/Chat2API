import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { SseKeepAliveStream } from '../../src/main/proxy/utils/sseKeepAlive.ts'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('SSE keep-alive emits legal comments during a quiet stream', async () => {
  const stream = new SseKeepAliveStream({ intervalMs: 10 })
  const chunks: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => chunks.push(chunk))

  await wait(35)
  assert.match(chunks.join(''), /: keep-alive\n\n/)

  stream.end('data: [DONE]\n\n')
  await once(stream, 'close')
})

test('real SSE writes reset the keep-alive quiet period', async () => {
  const stream = new SseKeepAliveStream({ intervalMs: 30 })
  const chunks: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => chunks.push(chunk))

  stream.write('data: progress\n\n')
  await wait(15)
  assert.equal(chunks.join(''), 'data: progress\n\n')

  await wait(30)
  assert.match(chunks.join(''), /: keep-alive\n\n/)
  stream.destroy()
  await once(stream, 'close')
})

test('zero disables SSE keep-alive', async () => {
  const stream = new SseKeepAliveStream({ intervalMs: 0 })
  const chunks: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => chunks.push(chunk))

  await wait(35)
  assert.equal(chunks.length, 0)
  stream.end()
  await once(stream, 'close')
})
