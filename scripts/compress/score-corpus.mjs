/**
 * Score a corpus with the proxy's own estimator rules.
 *
 * Used for the baseline, which the proxy cannot report itself: it only logs
 * `before` when the optimizer is enabled. The number is only trustworthy if it
 * agrees with the proxy on the same corpus, so `verifyAgainst` prints both.
 */
import fs from 'node:fs'

export function estimateTokens(value) {
  let ascii = 0
  let nonAscii = 0
  for (const codePoint of value) {
    if (codePoint.codePointAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 3) + nonAscii
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        if (part.type === 'text' && part.text) return part.text
        if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
          return part.image_url.url
        }
        if (part.type === 'file' && part.file && typeof part.file.file_id === 'string') {
          return part.file.file_id
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

export function estimateMessage(message) {
  let tokens = estimateTokens(String(message.role || ''))
    + estimateTokens(String(message.name || ''))
    + estimateTokens(String(message.tool_call_id || ''))
  const body = contentText(message.content)
  if (body) tokens += estimateTokens(body)
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls))
  }
  return tokens
}

export function estimateRequest(request) {
  const messages = (request.messages || []).reduce((sum, m) => sum + estimateMessage(m), 0)
  const tools = request.tools?.length ? estimateTokens(JSON.stringify(request.tools)) : 0
  return Math.max(1, messages + tools)
}

export function scoreCorpus(corpus) {
  return corpus.reduce((sum, request) => sum + estimateRequest(request), 0)
}

if (process.argv[2]) {
  const corpus = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const total = scoreCorpus(corpus)
  console.log(`corpus tokens: ${total.toLocaleString()} (${corpus.length} requests)`)
  if (process.argv[3]) fs.writeFileSync(process.argv[3], String(total))
}
