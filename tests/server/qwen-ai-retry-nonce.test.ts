import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const runtimeRequire = createRequire(import.meta.url)

function loadFilesModule() {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const testRequire = specifier => {
    if (specifier.startsWith('.')) {
      // The multimodal message builder pulls sibling helpers; provide inert
      // stubs — only applyQwenAiRetryNonce is under test here.
      return new Proxy({}, { get: () => () => { throw new Error('stub: ' + specifier) } })
    }
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const { applyQwenAiRetryNonce } = loadFilesModule()

const SAMPLE = 'chat transcript body\nline two'

test('retry nonce with default always scope perturbs attempt >= 1', () => {
  assert.equal(applyQwenAiRetryNonce(SAMPLE, undefined), SAMPLE, 'missing nonce stays pristine')
  assert.match(applyQwenAiRetryNonce(SAMPLE, 1), /\[chat2api transport note: conversation resync 1-/, 'default always scope perturbs attempt 1')

  const second = applyQwenAiRetryNonce(SAMPLE, 2)
  assert.ok(second.startsWith(SAMPLE), 'marker appends after the original content')
  assert.match(second, /\[chat2api transport note: conversation resync 2-[0-9a-z]+-[0-9a-z]+\]/)
  assert.notEqual(second, applyQwenAiRetryNonce(SAMPLE, 3), 'each retry hashes differently')
  assert.notEqual(
    applyQwenAiRetryNonce(SAMPLE, 2),
    applyQwenAiRetryNonce(SAMPLE, 2),
    'same attempt number still differs across invocations (timestamp component)',
  )
})

test('retry nonce scope=retry keeps attempt 1 pristine', () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE
  process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE = 'retry'
  try {
    assert.equal(applyQwenAiRetryNonce(SAMPLE, 1), SAMPLE, 'retry scope keeps attempt-1 upload-cache path')
    assert.match(applyQwenAiRetryNonce(SAMPLE, 2), /conversation resync 2-/)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE
    else process.env.CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE = previous
  }
})

test('retry nonce honors the disable flag', () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_NONCE
  process.env.CHAT2API_QWEN_AI_RETRY_NONCE = 'false'
  try {
    assert.equal(applyQwenAiRetryNonce(SAMPLE, 5), SAMPLE, 'disabled flag keeps content pristine')
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_NONCE
    else process.env.CHAT2API_QWEN_AI_RETRY_NONCE = previous
  }
})
