import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

// The parse retry knobs are read at call time, so these only tune test speed.
process.env.QWEN_AI_FILE_PARSE_RETRY_DELAY_MS = '10'
process.env.QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS = '10'

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
      if (specifier === './webshareProxy' || specifier === '../webshareProxy') {
        return {
          isWebshareProxyEnabled: () => false,
          isWebshareStickyActive: () => false,
          maybeProbeWebshareDirectExit: () => {},
          engageWebshareStickyMode: () => {},
          disengageWebshareStickyMode: () => {},
          reportWebshareProxyFailure: () => {},
          reportWebshareProxySuccess: () => {},
          getWebshareProxyAgent: () => undefined,
          webshareProxyUrlForLog: () => undefined,
        }
      }
      throw new Error(`Unexpected Qwen AI files test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const PARSE_URL = 'https://chat.qwen.ai/api/v2/files/parse'
const PARSE_STATUS_URL = 'https://chat.qwen.ai/api/v2/files/parse/status'
const FILE_ID = 'file-parse-1'

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

const parseCalls = calls => calls.filter(call => call.url === PARSE_URL)

test('parse POST retries in place after a gateway 504 and then succeeds', async () => {
  let parsePostCount = 0
  const { uploader, calls } = createUploader(async url => {
    if (url === PARSE_URL) {
      parsePostCount += 1
      if (parsePostCount === 1) return { status: 504, data: {} }
      return { status: 200, data: { success: true } }
    }
    assert.equal(url, PARSE_STATUS_URL)
    return { status: 200, data: { data: { [FILE_ID]: { status: 'success' } } } }
  })

  await uploader.parseDocument(FILE_ID, {})

  assert.equal(parseCalls(calls).length, 2, 'expected one in-place retry after the 504')
})

test('parse POST keeps the account-neutral classification after retry exhaustion', async () => {
  const { uploader, calls } = createUploader(async url => {
    if (url === PARSE_URL) return { status: 504, data: {} }
    return { status: 200, data: { data: { [FILE_ID]: { status: 'success' } } } }
  })

  const error = await uploader.parseDocument(FILE_ID, {}).then(
    () => null,
    err => err,
  )

  assert.ok(error, 'expected the parse request to fail after retries')
  assert.equal(parseCalls(calls).length, 3, 'expected 1 initial attempt + 2 in-place retries')
  assert.equal(error.status, 504)
  assert.equal(error.code, 'qwen_ai_file_parse_http_error')
  assert.equal(error.retryable, false)
  assert.equal(error.accountFault, false)
  assert.equal(error.retryScope, 'next-account')
  assert.match(error.message, /HTTP 504/)
})

test('parse POST does not retry client errors', async () => {
  const { uploader, calls } = createUploader(async url => {
    if (url === PARSE_URL) return { status: 401, data: {} }
    return { status: 200, data: { data: { [FILE_ID]: { status: 'success' } } } }
  })

  const error = await uploader.parseDocument(FILE_ID, {}).then(
    () => null,
    err => err,
  )

  assert.ok(error)
  assert.equal(parseCalls(calls).length, 1, '4xx parse rejections must fail without in-place retries')
  assert.equal(error.code, 'qwen_ai_file_parse_http_error')
  assert.equal(error.status, 401)
})

test('parse POST retries a transport timeout and preserves the abort path', async () => {
  let parsePostCount = 0
  const { uploader, calls } = createUploader(async url => {
    if (url === PARSE_URL) {
      parsePostCount += 1
      if (parsePostCount === 1) {
        throw Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED' })
      }
      return { status: 200, data: { success: true } }
    }
    return { status: 200, data: { data: { [FILE_ID]: { status: 'success' } } } }
  })

  await uploader.parseDocument(FILE_ID, {})

  assert.equal(parseCalls(calls).length, 2, 'expected the request-level timeout to be retried in place')
})

test('parse POST in-place retry stays abortable by the client', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  const { uploader, calls } = createUploader(async url => {
    if (url === PARSE_URL) return { status: 504, data: {} }
    return { status: 200, data: { data: { [FILE_ID]: { status: 'success' } } } }
  })

  const error = await uploader.parseDocument(FILE_ID, { signal: controller.signal }).then(
    () => null,
    err => err,
  )

  assert.ok(error)
  assert.equal(error.code, 'ERR_CANCELED')
  assert.equal(error.status, 499)
  assert.equal(parseCalls(calls).length, 1, 'abort must cut the retry loop before the next parse call')
})
