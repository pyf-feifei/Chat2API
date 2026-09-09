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

test('retry nonce appends an inert marker only on attempts >= 2', () => {
  assert.equal(applyQwenAiRetryNonce(SAMPLE, undefined), SAMPLE, 'first attempt must stay pristine')
  assert.equal(applyQwenAiRetryNonce(SAMPLE, 1), SAMPLE, 'attempt 1 must stay pristine')

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
