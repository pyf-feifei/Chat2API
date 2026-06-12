import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const qwenAiSource = fs.readFileSync('src/main/providers/builtin/qwen-ai.ts', 'utf8')
const storeTypesSource = fs.readFileSync('src/main/store/types.ts', 'utf8')
const storeSource = fs.readFileSync('src/main/store/store.ts', 'utf8')
const ipcSource = fs.readFileSync('src/main/ipc/handlers.ts', 'utf8')
const managementProvidersSource = fs.readFileSync('src/main/proxy/routes/management/providers.ts', 'utf8')
const providerCheckerSource = fs.readFileSync('src/main/providers/checker.ts', 'utf8')
const modelSyncSource = fs.readFileSync('src/main/providers/modelSync.ts', 'utf8')
const providerCardSource = fs.readFileSync('src/renderer/src/components/providers/ProviderCard.tsx', 'utf8')

function loadModelSyncModule() {
  const output = ts.transpileModule(modelSyncSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText

  const module = { exports: {} }
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
  })

  return module.exports
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('Qwen AI defaults include the current anonymous international model set', () => {
  assert.match(qwenAiSource, /'Qwen3\.7-Plus'/)
  assert.match(qwenAiSource, /'Qwen3\.7-Plus':\s*'qwen3\.7-plus'/)
  assert.match(qwenAiSource, /'Qwen3\.7-Max':\s*'qwen3\.7-max'/)
  assert.match(qwenAiSource, /'Qwen3\.6-Plus':\s*'qwen3\.6-plus'/)
  assert.doesNotMatch(qwenAiSource, /Qwen3\.6-35B-A3B/)
  assert.doesNotMatch(qwenAiSource, /Qwen3\.6-27B/)
  assert.doesNotMatch(qwenAiSource, /Qwen3-Coder/)
  assert.match(storeTypesSource, /export \{ builtinProviders as BUILTIN_PROVIDERS \} from '\.\.\/providers\/builtin\/index\.ts'/)
})

test('Qwen AI model sync uses a shared parser that accepts v1 and v2 response envelopes', () => {
  assert.match(qwenAiSource, /modelsApiEndpoint:\s*'https:\/\/chat\.qwen\.ai\/api\/v2\/models\/'/)
  assert.match(ipcSource, /parseProviderModelsResponse/)
  assert.match(managementProvidersSource, /parseProviderModelsResponse/)
  assert.match(providerCheckerSource, /parseProviderModelsResponse/)
  assert.doesNotMatch(ipcSource, /const models = response\.data\.data \|\| response\.data/)
  assert.doesNotMatch(managementProvidersSource, /const models = response\.data\.data \|\| response\.data/)
  assert.doesNotMatch(providerCheckerSource, /const models = response\.data\.data \|\| \[\]/)
})

test('provider model parser handles Qwen AI v1 and v2 envelopes without duplicating route logic', () => {
  assert.match(modelSyncSource, /function extractModelsPayload/)
  assert.match(modelSyncSource, /Array\.isArray\(responseData\)/)
  assert.match(modelSyncSource, /Array\.isArray\(data\)/)
  assert.match(modelSyncSource, /nestedData/)
  assert.match(modelSyncSource, /Array\.isArray\(nestedData\)/)
  assert.match(modelSyncSource, /modelMappings\[modelName\] = modelId/)
})

test('provider model parser maps live Qwen AI response shapes to display names and ids', () => {
  const { parseProviderModelsResponse } = loadModelSyncModule()

  assert.deepEqual(
    plain(parseProviderModelsResponse({
      data: [
        { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus' },
        { id: 'qwen3.7-max', name: 'Qwen3.7-Max' },
      ],
    })),
    {
      supportedModels: ['Qwen3.7-Plus', 'Qwen3.7-Max'],
      modelMappings: {
        'Qwen3.7-Plus': 'qwen3.7-plus',
        'Qwen3.7-Max': 'qwen3.7-max',
      },
    },
  )

  assert.deepEqual(
    plain(parseProviderModelsResponse({
      success: true,
      data: {
        data: [
          { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus' },
        ],
      },
    })),
    {
      supportedModels: ['Qwen3.6-Plus'],
      modelMappings: {
        'Qwen3.6-Plus': 'qwen3.6-plus',
      },
    },
  )

  assert.deepEqual(
    plain(parseProviderModelsResponse(['raw-model-id'])),
    {
      supportedModels: ['raw-model-id'],
      modelMappings: {
        'raw-model-id': 'raw-model-id',
      },
    },
  )
})

test('persisted built-in providers keep model sync endpoint metadata for the update button', () => {
  assert.match(storeTypesSource, /modelsApiEndpoint\?: string/)
  assert.match(storeTypesSource, /modelsApiHeaders\?: Record<string, string>/)
  assert.match(storeSource, /modelsApiEndpoint: builtinConfig\.modelsApiEndpoint/)
  assert.match(storeSource, /modelsApiHeaders: builtinConfig\.modelsApiHeaders/)
  assert.match(providerCardSource, /provider\.modelsApiEndpoint/)
  assert.doesNotMatch(providerCardSource, /\(provider as any\)\.modelsApiEndpoint/)
})
