import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('OpenAI chat content type includes file parts for multimodal clients', () => {
  const source = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(source, /type:\s*'text'\s*\|\s*'image_url'\s*\|\s*'file'/)
  assert.match(source, /file_url\?:\s*\{/)
  assert.match(source, /filename\?:\s*string/)
})

test('OpenAI chat content type includes audio and video parts for multimodal clients', () => {
  const source = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(source, /'input_audio'/)
  assert.match(source, /'video_url'/)
  assert.match(source, /input_audio\?:\s*\{/)
  assert.match(source, /data:\s*string/)
  assert.match(source, /format\?:\s*string/)
  assert.match(source, /video_url\?:\s*\{/)
})

test('Qwen AI has a dedicated multimodal upload helper', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /class QwenAiFileUploader/)
  assert.match(source, /\/api\/v2\/files\/getstsToken/)
  assert.match(source, /\/api\/v2\/files\/parse/)
  assert.match(source, /\/api\/v2\/files\/parse\/status/)
  assert.match(source, /\.put\(sts\.filePath,\s*file\.data/)
  assert.doesNotMatch(source, /console\.log\([^)]*base64/i)
})

test('Qwen AI multimodal helper accepts audio and video inputs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /part\.type === 'input_audio'/)
  assert.match(source, /part\.type === 'video_url'/)
  assert.match(source, /coarseType:\s*'audio',\s*fileClass:\s*'audio'/)
  assert.match(source, /coarseType:\s*'video',\s*fileClass:\s*'video'/)
  assert.match(source, /input-audio-\$\{uuid\(\)\}/)
  assert.doesNotMatch(source, /audio\/video input is not supported/)
})

test('Qwen AI Docker upload limit defaults to the web video limit of 2000 MB', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /const MAX_FILE_SIZE = 2000 \* 1024 \* 1024/)
  assert.match(source, /Qwen AI file upload exceeds \$\{MAX_FILE_SIZE\} bytes/)
})

test('Qwen AI file payload preserves audio and video file types', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /const type = file\.coarseType/)
  assert.match(source, /showType:\s*type/)
  assert.match(source, /filetype:\s*file\.coarseType/)
})

test('Qwen AI adapter sends prepared multimodal files instead of a fixed empty list', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /QwenAiFileUploader/)
  assert.match(source, /prepareQwenAiMultimodalMessage/)
  assert.match(source, /const qwenFiles = preparedUserMessage\.files/)
  assert.match(source, /files:\s*qwenFiles/)
  assert.doesNotMatch(source, /files:\s*\[\]/)
})

test('Qwen AI adapter redacts sensitive request headers in logs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /sanitizeHeadersForLog/)
  assert.match(source, /sanitizePayloadForLog/)
  assert.match(source, /JSON\.stringify\(this\.sanitizeHeadersForLog\(this\.getHeaders\(chatId\)\)/)
  assert.match(source, /JSON\.stringify\(this\.sanitizeHeadersForLog\(response\.headers\)/)
  assert.match(source, /JSON\.stringify\(this\.sanitizePayloadForLog\(payload\)/)
  assert.match(source, /'set-cookie'/)
  assert.doesNotMatch(source, /JSON\.stringify\(this\.getHeaders\(chatId\)/)
  assert.doesNotMatch(source, /JSON\.stringify\(payload,\s*null,\s*2\)/)
})

test('Qwen AI adapter rejects risk-control and non-stream upstream responses', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /assertChatCompletionStreamResponse/)
  assert.match(source, /hasRiskControlHeaders/)
  assert.match(source, /bxpunish/)
  assert.match(source, /x5sec/)
  assert.match(source, /status\s*=\s*403/)
  assert.match(source, /qwen_ai_risk_control/)
  assert.match(source, /REDACTED_URL/)
  assert.match(source, /x5secdata\|x5sectag\|cookie\|authorization\|token/)
  assert.match(source, /returned a risk-control or challenge response instead of a chat event stream/)
  assert.match(source, /returned a non-stream response instead of a chat event stream/)
})

test('Qwen AI adapter no longer hard-codes stale Baxia challenge headers', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /Version:\s*'0\.2\.67'/)
  assert.match(source, /currentTimezoneHeader/)
  assert.match(source, /baxiaUidToken/)
  assert.match(source, /headers\['bx-umidtoken'\] = baxiaUidToken/)
  assert.doesNotMatch(source, /T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN/)
  assert.doesNotMatch(source, /TimeZone: 'Mon Feb 23 2026/)
  assert.doesNotMatch(source, /Timezone: 'Mon Feb 23 2026/)
  assert.doesNotMatch(source, /Version: '0\.2\.7'/)
})

test('Qwen AI adapter uses browser cookies as the primary web session credential', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /const cookies = this\.getCookies\(\)/)
  assert.match(source, /Sending browser cookies together with desktop bearer auth/)
  assert.match(source, /if \(token && !cookies\)/)
  assert.match(source, /headers\.source = 'desktop'/)
  assert.match(source, /headers\['Cookie'\] = cookies/)
})

test('Qwen AI non-stream responses reject empty upstream output instead of returning fake success', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /let sawAnswerFinish = false/)
  assert.match(source, /const hasAnyOutput = Boolean\(answerText\.trim\(\) \|\| finalReasoning\.trim\(\)\)/)
  assert.match(source, /rejectOnce\(new Error\('Qwen AI returned an empty response stream without answer or reasoning content'\)\)/)
  assert.match(source, /Non-stream closed before an answer finished event; returning accumulated content/)
})

test('load balancer does not print account tokens', () => {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')

  assert.doesNotMatch(source, /credentials\.token/)
  assert.doesNotMatch(source, /Token:/)
})
