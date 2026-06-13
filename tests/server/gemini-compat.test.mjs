import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Gemini compatibility routes are registered alongside OpenAI routes', () => {
  const routeIndex = fs.readFileSync('src/main/proxy/routes/index.ts', 'utf8')
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')

  assert.match(routeIndex, /geminiRouter/)
  assert.match(routeIndex, /from '\.\/gemini'/)
  assert.match(serverSource, /POST \/v1beta\/models\/:model:generateContent/)
  assert.match(serverSource, /POST \/upload\/v1beta\/files/)
  assert.match(serverSource, /disableBodyParser\?\: boolean/)
  assert.match(serverSource, /disableBodyParser = true/)
})

test('Gemini translator maps contents parts to OpenAI-compatible chat messages', () => {
  const source = fs.readFileSync('src/main/proxy/gemini/translator.ts', 'utf8')

  assert.match(source, /export function geminiToChatCompletionRequest/)
  assert.match(source, /inlineData/)
  assert.match(source, /fileData/)
  assert.match(source, /video_url/)
  assert.match(source, /image_url/)
  assert.match(source, /input_audio/)
  assert.match(source, /function chatCompletionToGeminiResponse/)
  assert.match(source, /finishReason/)
})

test('Gemini file store supports official resumable upload flow and 48 hour ttl', () => {
  const source = fs.readFileSync('src/main/proxy/gemini/fileStore.ts', 'utf8')

  assert.match(source, /GEMINI_FILE_TTL_MS = 48 \* 60 \* 60 \* 1000/)
  assert.match(source, /X-Goog-Upload-Protocol/)
  assert.match(source, /X-Goog-Upload-Command/)
  assert.match(source, /X-Goog-Upload-URL/)
  assert.match(source, /storeUploadChunk/)
  assert.match(source, /files\/\$\{file\.id\}/)
  assert.match(source, /ctx\.origin/)
  assert.doesNotMatch(source, /X-Goog-Upload-URL', `\/upload\/v1beta\/files\/\$\{id\}`/)
  assert.doesNotMatch(source, /TODO|TBD|implement later/i)
})

test('Gemini route forwards generateContent through existing OpenAI request forwarder', () => {
  const source = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')

  assert.match(source, /new Router\(\)/)
  assert.doesNotMatch(source, /router\.post\('\/v1beta\/models\/:model:generateContent'/)
  assert.doesNotMatch(source, /router\.post\('\/v1beta\/models\/:model:streamGenerateContent'/)
  assert.match(source, /generateContentRoutePattern/)
  assert.match(source, /streamGenerateContentRoutePattern/)
  assert.match(source, /ctx\.captures/)
  assert.match(source, /requestForwarder\.forwardChatCompletion/)
  assert.match(source, /geminiToChatCompletionRequest/)
  assert.match(source, /chatCompletionToGeminiResponse/)
  assert.match(source, /chatCompletionStreamToGeminiSse/)
  assert.match(source, /geminiFileStore/)
})
