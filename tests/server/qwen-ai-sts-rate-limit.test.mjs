import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

// Env knobs are read once at module load, so set them before transpiling.
process.env.QWEN_AI_STS_REQUEST_MIN_INTERVAL_MS = '60'
process.env.QWEN_AI_STS_RATE_LIMIT_MAX_RETRIES = '2'
process.env.QWEN_AI_STS_RATE_LIMIT_BASE_DELAY_MS = '80'

const runtimeRequire = createRequire(import.meta.url)

function loadQwenAiFilesModule() {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const localModules = {
    '../toolCalling/providerProfiles.ts': {
      getProviderToolProfile: () => ({}),
    },
    '../toolCalling/managedPromptMetadata.ts': {
      getManagedToolDocumentPrompt: () => '',
      isManagedToolPromptMessage: () => false,
    },
    '../../runtime/index.ts': {
      getRuntime: () => ({ getDataDir: () => '.' }),
    },
    'ali-oss': class {},
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected Qwen AI files test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const RATE_LIMITED_BODY = {
  success: false,
  data: { code: 'RateLimited', details: 'Too many requests in a short period.' },
}

const VALID_STS_BODY = {
  success: true,
  data: {
    access_key_id: 'STS.test-key-id',
    access_key_secret: 'test-secret',
    security_token: 'test-token',
    bucketname: 'test-bucket',
    region: 'oss-cn-test',
    endpoint: 'https://oss-cn-test.aliyuncs.com',
    file_id: 'file-test-1',
    file_path: 'test/file-test-1.png',
    file_url: 'https://cdn.example.com/test/file-test-1.png',
  },
}

const TEST_FILE = {
  filename: 'screenshot.png',
  sizeBytes: 128 * 1024,
  coarseType: 'image',
  mimeType: 'image/png',
  fileClass: 'vision',
}

function createUploader(post) {
  const { QwenAiFileUploader } = loadQwenAiFilesModule()
  const calls = []
  const axiosInstance = {
    post: async (url, payload, options) => {
      calls.push({ url, payload, at: Date.now() })
      return post(url, payload, options)
    },
  }
  const uploader = new QwenAiFileUploader(
    axiosInstance,
    () => ({ Authorization: 'Bearer test-token' }),
    undefined,
    { providerId: 'qwen-ai', accountId: 'account-1' },
  )
  return { uploader, calls }
}

test('Qwen AI STS request retries a rate-limited response in place and then succeeds', async () => {
  const responses = [RATE_LIMITED_BODY, VALID_STS_BODY]
  const { uploader, calls } = createUploader(async () => ({
    status: 200,
    data: responses.length > 1 ? responses.shift() : responses[0],
  }))

  const startedAt = Date.now()
  const sts = await uploader.requestSts(TEST_FILE, {})
  const elapsedMs = Date.now() - startedAt

  assert.equal(sts.fileId, 'file-test-1')
  assert.equal(calls.length, 2, 'expected one retry after the rate-limited response')
  assert.ok(
    elapsedMs >= 80,
    `expected the retry to wait out the backoff window, took only ${elapsedMs}ms`,
  )
  assert.ok(
    calls.every(call => call.url === 'https://chat.qwen.ai/api/v2/files/getstsToken'),
    'retry must hit the same STS endpoint',
  )
})

test('Qwen AI STS request keeps the next-account classification after retry exhaustion', async () => {
  const { uploader, calls } = createUploader(async () => ({ status: 200, data: RATE_LIMITED_BODY }))

  const error = await uploader.requestSts(TEST_FILE, {}).then(
    () => null,
    err => err,
  )

  assert.ok(error, 'expected the rate-limited STS request to fail after retries')
  assert.equal(calls.length, 3, 'expected 1 initial attempt + 2 in-place retries')
  assert.equal(error.status, 503)
  assert.equal(error.code, 'qwen_ai_upload_sts_unavailable')
  assert.equal(error.retryable, true)
  assert.equal(error.accountFault, false)
  assert.equal(error.retryScope, 'next-account')
  assert.match(error.message, /RateLimited/)
})

test('Qwen AI STS request does not retry non-rate-limit error bodies', async () => {
  const { uploader, calls } = createUploader(async () => ({
    status: 200,
    data: { success: false, data: { code: 'Unauthorized', details: '401 Unauthorized' } },
  }))

  const error = await uploader.requestSts(TEST_FILE, {}).then(
    () => null,
    err => err,
  )

  assert.ok(error)
  assert.equal(calls.length, 1, 'non-rate-limit failures must not burn time on in-place retries')
  assert.equal(error.code, 'qwen_ai_upload_sts_unavailable')
})

test('Qwen AI STS requests are paced process-wide across concurrent uploads', async () => {
  const { uploader, calls } = createUploader(async () => ({ status: 200, data: VALID_STS_BODY }))

  await Promise.all([
    uploader.requestSts({ ...TEST_FILE, filename: 'a.png' }, {}),
    uploader.requestSts({ ...TEST_FILE, filename: 'b.png' }, {}),
    uploader.requestSts({ ...TEST_FILE, filename: 'c.png' }, {}),
  ])

  assert.equal(calls.length, 3)
  for (let index = 1; index < calls.length; index += 1) {
    const gapMs = calls[index].at - calls[index - 1].at
    assert.ok(
      gapMs >= 55,
      `expected STS dispatches to be spaced by the configured 60ms pacer, got ${gapMs}ms`,
    )
  }
})

test('Qwen AI STS rate-limit backoff stays abortable by the client', async () => {
  const { uploader, calls } = createUploader(async () => ({ status: 200, data: RATE_LIMITED_BODY }))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)

  const error = await uploader.requestSts(TEST_FILE, { signal: controller.signal }).then(
    () => null,
    err => err,
  )

  assert.ok(error, 'expected an abort during the backoff wait to reject')
  assert.equal(error.code, 'ERR_CANCELED')
  assert.equal(error.status, 499)
  assert.equal(calls.length, 1, 'abort must cut the retry loop before the next STS call')
})

test('Qwen AI STS rate-limit handling is wired with bounded, configurable knobs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /QWEN_AI_STS_REQUEST_MIN_INTERVAL_MS',\s*1500/)
  assert.match(source, /QWEN_AI_STS_RATE_LIMIT_MAX_RETRIES',\s*3/)
  assert.match(source, /QWEN_AI_STS_RATE_LIMIT_BASE_DELAY_MS',\s*15000/)
  assert.match(source, /acquireQwenAiStsDispatchSlot/)
  assert.match(source, /isQwenAiStsRateLimited/)
  assert.match(source, /rateLimitRetries >= STS_RATE_LIMIT_MAX_RETRIES/)
})

test('Qwen AI governor benches an account whose STS rate-limit retries are exhausted', () => {
  const source = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(source, /result\.errorCode === 'qwen_ai_upload_sts_unavailable'/)
  assert.match(source, /'qwen_ai_upload_sts_rate_limited'/)
})

test('docker-compose passes the STS pacing knobs through to the container', () => {
  const source = fs.readFileSync('docker-compose.yml', 'utf8')

  assert.match(source, /QWEN_AI_STS_REQUEST_MIN_INTERVAL_MS/)
  assert.match(source, /QWEN_AI_STS_RATE_LIMIT_MAX_RETRIES/)
  assert.match(source, /QWEN_AI_STS_RATE_LIMIT_BASE_DELAY_MS/)
})
