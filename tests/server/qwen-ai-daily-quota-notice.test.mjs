import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

/**
 * Extract the two exported quota helpers from qwen-ai.ts. The file is huge and
 * pulls in axios/http2, so bundle it with the network side stubbed out and
 * re-export the helpers from a tiny entry module.
 */
async function loadQuotaHelpers() {
  const src = fs.readFileSync(
    path.join(repoRoot, 'src', 'main', 'proxy', 'adapters', 'qwen-ai.ts'),
    'utf8',
  )

  // Pull the helper block verbatim so the test exercises the shipped source.
  const start = src.indexOf('const QWEN_AI_DAILY_QUOTA_NOTICES')
  assert.ok(start > 0, 'quota notice table not found in qwen-ai.ts')
  const end = src.indexOf('\nfunction createQwenAiToolValidationError', start)
  const slice = src.slice(start, end > start ? end : start + 6000)

  const entry = `
    type QwenAiUpstreamError = Error & {
      status?: number; code?: string; retryable?: boolean; accountFault?: boolean
    }
    function createQwenAiStreamFailure(
      message: string,
      code: string = 'qwen_ai_stream_incomplete',
    ): QwenAiUpstreamError {
      const error = new Error(message) as QwenAiUpstreamError
      error.status = 502
      error.code = code
      error.retryable = false
      return error
    }
    ${slice}
    export { createQwenAiDailyQuotaError }
    export { isQwenAiDailyQuotaNotice as _isNotice }
  `

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-quota-'))
  const out = path.join(dir, 'm.mjs')
  // The slice already declares `export` on isQwenAiDailyQuotaNotice, so only
  // re-export the unexported factory.
  await esbuild.build({
    stdin: { contents: entry, loader: 'ts', resolveDir: repoRoot, sourcefile: 'entry.ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  })
  return import(`file:///${out.replace(/\\/g, '/')}`)
}

describe('qwen ai daily quota notice', () => {
  it('detects the observed upstream refusal', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    // Verbatim from the 2026-09-26 capture.
    assert.equal(
      isQwenAiDailyQuotaNotice('今日对话次数已达上限，请明日再来。', ''),
      true,
    )
  })

  it('detects close variants', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    const notices = [
      '今日对话次数已达上限',
      '您今日的聊天次数已达上限，请明日再来',
      '对话次数已达上限',
      '请明日再来',
      '今日已用完',
      "You've reached your daily limit. Please try again tomorrow.",
    ]
    for (const n of notices) {
      assert.equal(isQwenAiDailyQuotaNotice(n, ''), true, `missed: ${n}`)
    }
  })

  it('detects the English notice observed on 2026-09-26', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    // Verbatim from a real refusal on the local instance.
    const notices = [
      "You've reached today's chat limit. Please try again tomorrow.",
      "You've reached your daily limit",
      'You have exceeded your daily quota',
      'Daily chat limit reached',
      'Please try again tomorrow',
    ]
    for (const n of notices) {
      assert.equal(isQwenAiDailyQuotaNotice(n, ''), true, `missed: ${n}`)
    }
  })

  it('does not misfire on ordinary answers', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    const answers = [
      'PONG',
      'OK',
      '今天天气很好。',
      'The answer is 42.',
      'Quota handling is implemented by rotating accounts.',
      '请明日再来之前，先把这个任务做完。', // contains the phrase but is a real instruction
      // A real answer about limits must not be parked. Both are longer than
      // the notice cap, and the second would match a loose "daily ... limit"
      // pattern if the length guard were removed.
      'The daily chat limit applies per account, and the implementation rotates accounts when the quota is exhausted so the pool keeps serving requests.',
      'Yes, please try again tomorrow if the rate limit is still in effect.',
    ]
    for (const a of answers) {
      assert.equal(isQwenAiDailyQuotaNotice(a, ''), false, `false positive: ${a}`)
    }
  })

  it('ignores a refusal-shaped string when real reasoning was produced', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    // The model reasoned about the topic and quoted the phrase in its answer.
    const answer = '今日对话次数已达上限，请明日再来。'
    const reasoning = 'The user asks about the daily cap; I will restate the notice and explain the reset time.'
    assert.equal(isQwenAiDailyQuotaNotice(answer, reasoning), false)
  })

  it('ignores long passages that merely mention the limit', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    const essay = `关于配额机制的系统性说明。${'今日对话次数已达上限，请明日再来。'.repeat(8)}`
    assert.equal(isQwenAiDailyQuotaNotice(essay, ''), false)
  })

  it('treats empty content as not a notice', async () => {
    const { isQwenAiDailyQuotaNotice } = await loadQuotaHelpers()
    assert.equal(isQwenAiDailyQuotaNotice('', ''), false)
    assert.equal(isQwenAiDailyQuotaNotice('   ', ''), false)
  })

  it('builds an error that rotates the account instead of blaming credentials', async () => {
    const { createQwenAiDailyQuotaError } = await loadQuotaHelpers()
    const e = createQwenAiDailyQuotaError()
    assert.equal(e.code, 'qwen_ai_daily_quota_exhausted')
    assert.equal(e.status, 429)
    // accountFault=true parks THIS account for the day; false would let the
    // governor escalate as if the pool were at fault.
    assert.equal(e.accountFault, true)
    assert.equal(e.retryable, false)
    assert.match(String(e.message), /daily conversation quota/i)
  })
})
