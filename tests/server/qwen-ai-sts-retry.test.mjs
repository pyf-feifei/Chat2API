import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

// The STS knobs are read at module load, so these only tune test speed.
process.env.QWEN_AI_STS_REQUEST_MIN_INTERVAL_MS = '1'
process.env.QWEN_AI_STS_TRANSIENT_RETRY_DELAY_MS = '10'

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

const STS_URL = 'https://chat.qwen.ai/api/v2/files/getstsToken'

const STS_OK_RESPONSE = {
  status: 200,
  data: {
    data: {
      file_id: 'file-sts-1',
      access_key_id: 'sts-ak',
      access_key_secret: 'sts-sk',
      security_token: 'sts-token',
      bucketname: 'sts-bucket',
      region: 'sts-region',
      endpoint: 'sts-endpoint',
      file_path: 'sts/a.png',
      file_url: 'https://cdn.example.com/sts/a.png',
    },
  },
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

const stsCalls = calls => calls.filter(call => call.url === STS_URL)

const DIRECT_INPUT = { sizeBytes: 100, filename: 'a.png' }

test('STS request retries in place after a gateway 504 and then succeeds', async () => {
  let stsPostCount = 0
  const { uploader, calls } = createUploader(async url => {
    assert.equal(url, STS_URL)
    stsPostCount += 1
    if (stsPostCount === 1) return { status: 504, data: {} }
    return STS_OK_RESPONSE
  })

  const result = await uploader.startDirectUpload(DIRECT_INPUT, {})

  assert.equal(stsCalls(calls).length, 2, 'expected one in-place retry after the 504')
  assert.equal(result.upload.fileId, 'file-sts-1')
})

test('STS request retries a transport timeout in place', async () => {
  let stsPostCount = 0
  const { uploader, calls } = createUploader(async url => {
    assert.equal(url, STS_URL)
    stsPostCount += 1
    if (stsPostCount === 1) {
      throw Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED' })
    }
    return STS_OK_RESPONSE
  })

  const result = await uploader.startDirectUpload(DIRECT_INPUT, {})

  assert.equal(stsCalls(calls).length, 2, 'expected the request-level timeout to be retried in place')
  assert.equal(result.upload.fileId, 'file-sts-1')
})

test('STS request keeps failing after transient retry exhaustion', async () => {
  const { uploader, calls } = createUploader(async () => ({ status: 504, data: {} }))

  const error = await uploader.startDirectUpload(DIRECT_INPUT, {}).then(
    () => null,
    err => err,
  )

  assert.ok(error, 'expected the STS request to fail after retries')
  assert.equal(stsCalls(calls).length, 3, 'expected 1 initial attempt + 2 transient retries')
  assert.match(error.message, /upload STS request failed: HTTP 504/)
})

test('STS request does not retry client errors', async () => {
  const { uploader, calls } = createUploader(async () => ({ status: 401, data: {} }))

  const error = await uploader.startDirectUpload(DIRECT_INPUT, {}).then(
    () => null,
    err => err,
  )

  assert.ok(error)
  assert.equal(stsCalls(calls).length, 1, '4xx STS rejections must fail without transient retries')
  assert.match(error.message, /upload STS request failed: HTTP 401/)
})

test('STS transient retry stays abortable by the client', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  const { uploader, calls } = createUploader(async () => ({ status: 504, data: {} }))

  const error = await uploader.startDirectUpload(DIRECT_INPUT, { signal: controller.signal }).then(
    () => null,
    err => err,
  )

  assert.ok(error)
  assert.equal(error.code, 'ERR_CANCELED')
  assert.equal(error.status, 499)
  assert.equal(stsCalls(calls).length, 1, 'abort must cut the retry loop before the next STS call')
})
