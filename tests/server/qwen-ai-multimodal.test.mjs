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

test('Qwen AI document upload waits for parse completion with a bounded timeout', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /const PARSE_POLL_TIMEOUT_MS = 120000/)
  assert.match(source, /while \(Date\.now\(\) < deadline\)/)
  assert.match(source, /Qwen AI file parse timed out after/)
  assert.doesNotMatch(source, /const PARSE_POLL_ATTEMPTS = 5/)
})

test('Qwen AI long text documents add generic evidence excerpts near the user request', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MARKER/)
  assert.match(source, /createDocumentEvidence\(file,\s*evidenceQueryText\)/)
  assert.match(source, /renderDocumentEvidence\(evidences\)/)
  assert.match(source, /TEXT_DOCUMENT_MIME_TYPES/)
  assert.match(source, /TEXT_DOCUMENT_EXTENSIONS/)
  assert.match(source, /KEY_VALUE_LINE_PATTERN/)
  assert.match(source, /KEY_VALUE_CONTEXT_PATTERN/)
  assert.match(source, /PATH_VALUE_CONTEXT_PATTERN/)
  assert.match(source, /Use only values that are present in the excerpts or the attached documents/)
  assert.match(source, /content = documentEvidence\s*\?\s*`\$\{userContent\}\\n\\n\$\{documentEvidence\}`/)
})

test('Qwen AI document evidence is bounded and configurable instead of hard-coded to one fixture', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MAX_TEXT_BYTES/)
  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS/)
  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS/)
  assert.match(source, /positiveIntegerFromEnv/)
  assert.match(source, /selectEvidenceSnippets\(decoded\.text,\s*queryText\)/)
  assert.doesNotMatch(source, /TARGET_PATH/)
  assert.doesNotMatch(source, /file-context-extra/)
  assert.doesNotMatch(source, /long-context-extra/)
})

test('Qwen AI does not forge or rewrite tool arguments from document evidence', () => {
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const filesSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.doesNotMatch(adapterSource, /filePath['"]?\s*[:=]/)
  assert.doesNotMatch(adapterSource, /arguments\s*=\s*.*preparedUserMessage/)
  assert.doesNotMatch(filesSource, /finish_reason/)
})

test('Qwen AI multimodal helper preserves full tool-call transcript instead of only the last user message', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /function buildQwenAiTranscript\(messages: ChatMessage\[\]\)/)
  assert.match(source, /getProviderToolProfile\('qwen'\)/)
  assert.match(source, /msg\.role === 'assistant'/)
  assert.match(source, /msg\.tool_calls\?\.length/)
  assert.match(source, /formatAssistantToolCalls\(msg\.tool_calls\.map/)
  assert.match(source, /msg\.role === 'tool'/)
  assert.match(source, /formatToolResult\(\{/)
  assert.match(source, /already executed by the client/)
  assert.match(source, /Do not repeat the same tool call unless/)
  assert.match(source, /fileParts\.push\(\.\.\.messageFileParts\)/)
  assert.match(source, /buildQwenAiTranscript\(messages\)/)
  assert.doesNotMatch(source, /userContent = textFromContent\(msg\.content\)/)
  assert.doesNotMatch(source, /fileParts\.splice\(0,\s*fileParts\.length/)
})

test('Qwen AI stream converts only declared upstream native function calls without fabricated arguments', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const nativeToolsSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-native-tools.ts', 'utf8')

  assert.match(source, /normalizeNativeFunctionCallDelta/)
  assert.match(nativeToolsSource, /delta\.function_call/)
  assert.match(nativeToolsSource, /delta\.tool_calls/)
  assert.match(source, /toolCallingPlan\.allowedToolNames\.has\(name\)/)
  assert.match(source, /Ignoring undeclared upstream native tool call/)
  assert.match(source, /isCompleteJsonText\(state\.arguments\)/)
  assert.match(source, /mergeNativeToolArguments\(existing\?\.arguments \?\? '', fragment\.arguments\)/)
  assert.match(source, /arguments:\s*state\.arguments/)
  assert.match(source, /finish_reason:\s*'tool_calls'/)
  assert.doesNotMatch(source, /function:\s*\{[\s\S]{0,120}arguments:\s*['"]\{\}['"]/)
})

test('Qwen AI stream isolates the primary upstream response branch before parsing tool calls', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /ignoredResponseIds = new Set<string>\(\)/)
  assert.match(source, /responseBranchLocked = false/)
  assert.match(source, /processedResponseEvent = false/)
  assert.match(source, /recordResponseCreated\(created: Record<string, any>\)/)
  assert.match(source, /shouldProcessResponseEvent\(data: Record<string, any>\)/)
  assert.match(source, /response_index/)
  assert.match(source, /Ignoring secondary response branch/)
  assert.match(source, /eventResponseId !== this\.responseId/)
  assert.match(source, /if \(!this\.shouldProcessResponseEvent\(data\)\)/)
  assert.match(source, /if \(!this\.shouldProcessResponseEvent\(parsed\)\)/)
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

test('Qwen AI adapter request timeout is configurable for long-context document runs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /QWEN_AI_REQUEST_TIMEOUT_MS/)
  assert.match(source, /process\.env\.QWEN_AI_REQUEST_TIMEOUT_MS \|\| 300000/)
  assert.doesNotMatch(source, /timeout:\s*120000/)
})

test('Qwen AI adapter redacts sensitive request headers in logs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /sanitizeHeadersForLog/)
  assert.match(source, /sanitizePayloadForLog/)
  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MARKER/)
  assert.match(source, /REDACTED_DOCUMENT_EVIDENCE/)
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
