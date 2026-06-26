import { readFileSync, statSync } from 'fs'
import axios, { AxiosInstance, AxiosResponse } from 'axios'
import OSS from 'ali-oss'
import mime from 'mime-types'
import path from 'path'
import type { ChatMessage, ChatMessageContent } from '../types'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const MAX_FILE_SIZE = 2000 * 1024 * 1024
const PARSE_POLL_INTERVAL_MS = 2000
const PARSE_POLL_TIMEOUT_MS = 120000
const DOCUMENT_EVIDENCE_MAX_TEXT_BYTES = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_TEXT_BYTES', 32 * 1024 * 1024)
const DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS', 24000)
const DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS', 12000)
const DOCUMENT_EVIDENCE_MAX_CANDIDATES = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_CANDIDATES', 256)
const DOCUMENT_EVIDENCE_SNIPPET_CHARS = 1600

export const QWEN_AI_DOCUMENT_EVIDENCE_MARKER = '[Attached document evidence]'

const TEXT_DOCUMENT_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/ld+json',
  'application/markdown',
  'application/toml',
  'application/x-ndjson',
  'application/x-toml',
  'application/x-www-form-urlencoded',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
])

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  '.conf',
  '.csv',
  '.env',
  '.ini',
  '.json',
  '.jsonl',
  '.log',
  '.markdown',
  '.md',
  '.properties',
  '.text',
  '.toml',
  '.tsv',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])

const COMMON_QUERY_TERMS = new Set([
  'about',
  'above',
  'after',
  'again',
  'also',
  'and',
  'any',
  'are',
  'argument',
  'arguments',
  'attached',
  'below',
  'call',
  'content',
  'document',
  'documents',
  'exactly',
  'file',
  'files',
  'for',
  'from',
  'function',
  'get',
  'has',
  'have',
  'into',
  'invoke',
  'json',
  'must',
  'need',
  'only',
  'output',
  'please',
  'request',
  'response',
  'schema',
  'should',
  'that',
  'the',
  'them',
  'this',
  'tool',
  'tools',
  'use',
  'using',
  'value',
  'with',
  'you',
  'your',
])

const KEY_VALUE_LINE_PATTERN = /^\s*["']?[A-Za-z][A-Za-z0-9_.-]{1,80}["']?\s*[:=]\s*\S.{0,1200}$/i
const PATH_VALUE_PATTERN = /(?:^|[\s"'=:[({,])(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^\s"'<>`),;\]}]{2,500}/i
const PATH_VALUE_CONTEXT_PATTERN = /(?:^|[\s"'=:[({,])(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^\s"'<>`),;\]}]{2,500}/gi
const KEY_VALUE_CONTEXT_PATTERN = /["']?[A-Za-z][A-Za-z0-9_.-]{1,80}["']?\s*[:=]\s*(?:"[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s,}\]\n]{1,500})/g

type HeaderFactory = () => Record<string, string>
type QwenPostWithRetry = (
  url: string,
  payload: unknown,
  createOptions: () => Record<string, any>,
) => Promise<AxiosResponse>

type QwenFileClass = 'vision' | 'document' | 'audio' | 'video'
type QwenCoarseFileType = 'image' | 'file' | 'audio' | 'video'

interface NormalizedInputFile {
  data: Buffer
  filename: string
  mimeType: string
  sourceUrl?: string
  coarseType: QwenCoarseFileType
  fileClass: QwenFileClass
}

interface QwenStsInfo {
  accessKeyId: string
  accessKeySecret: string
  securityToken?: string
  bucket: string
  region: string
  endpoint: string
  fileId: string
  filePath: string
  fileUrl: string
}

export interface PreparedQwenAiMessage {
  content: string
  files: any[]
}

interface QwenAiDocumentEvidence {
  filename: string
  mimeType: string
  textBytes: number
  truncated: boolean
  snippets: string[]
}

interface UploadedQwenAiPart {
  file: any
  evidence?: QwenAiDocumentEvidence
}

interface DocumentCandidateSnippet {
  priority: number
  position: number
  label: string
  text: string
}

interface CandidateInput {
  priority: number
  position: number
  label: string
  start: number
  end: number
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isDataUrl(url: string): boolean {
  return /^data:[^;,]+;base64,/i.test(url)
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function isChat2ApiFileUrl(url: string): boolean {
  return /^chat2api-file:\/\//i.test(url)
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || `upload-${uuid()}`
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const base = path.posix.basename(decodeURIComponent(parsed.pathname))
    return sanitizeFilename(base || `upload-${uuid()}`)
  } catch {
    return `upload-${uuid()}`
  }
}

function filenameFromContentDisposition(header?: string): string | undefined {
  if (!header) {
    return undefined
  }

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return sanitizeFilename(decodeURIComponent(utf8Match[1]))
  }

  const asciiMatch = header.match(/filename="?([^";]+)"?/i)
  if (asciiMatch?.[1]) {
    return sanitizeFilename(asciiMatch[1])
  }

  return undefined
}

function ensureExtension(filename: string, mimeType: string): string {
  if (path.extname(filename)) {
    return filename
  }

  const ext = mime.extension(mimeType)
  return ext ? `${filename}.${ext}` : filename
}

function normalizeAudioMimeType(format?: string, explicitMimeType?: string): string {
  if (explicitMimeType) {
    return explicitMimeType
  }

  const normalizedFormat = format?.toLowerCase().replace(/^\./, '')
  if (!normalizedFormat) {
    return 'audio/wav'
  }

  if (normalizedFormat === 'mp3') {
    return 'audio/mpeg'
  }

  if (normalizedFormat === 'm4a') {
    return 'audio/x-m4a'
  }

  return mime.lookup(normalizedFormat) || `audio/${normalizedFormat}`
}

function parseDataUrlPayload(value: string): { mimeType?: string; base64: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/is)
  if (!match) {
    return { base64: value }
  }

  return {
    mimeType: match[1],
    base64: match[2],
  }
}

function classifyFile(mimeType: string, explicitType: ChatMessageContent['type']): Pick<NormalizedInputFile, 'coarseType' | 'fileClass'> {
  if (explicitType === 'image_url' || mimeType.startsWith('image/')) {
    return { coarseType: 'image', fileClass: 'vision' }
  }

  if (mimeType.startsWith('audio/')) {
    return { coarseType: 'audio', fileClass: 'audio' }
  }

  if (mimeType.startsWith('video/')) {
    return { coarseType: 'video', fileClass: 'video' }
  }

  return { coarseType: 'file', fileClass: 'document' }
}

function extractDataUrl(
  url: string,
  filename?: string,
  explicitMimeType?: string,
  explicitType?: ChatMessageContent['type'],
): NormalizedInputFile {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/is)
  if (!match) {
    throw new Error('Unsupported data URL. Expected data:<mime>;base64,<content>.')
  }

  const mimeType = explicitMimeType || match[1] || 'application/octet-stream'
  const data = Buffer.from(match[2], 'base64')
  const rawFilename = filename || `upload-${uuid()}`
  const safeFilename = ensureExtension(sanitizeFilename(rawFilename), mimeType)
  const classification = classifyFile(mimeType, explicitType || (mimeType.startsWith('image/') ? 'image_url' : 'file'))

  return {
    data,
    filename: safeFilename,
    mimeType,
    ...classification,
  }
}

function extractInputAudio(part: ChatMessageContent): NormalizedInputFile {
  const data = part.input_audio?.data
  if (!data) {
    throw new Error('Missing data for input_audio content part')
  }

  const parsedData = parseDataUrlPayload(data)
  const mimeType = normalizeAudioMimeType(part.input_audio?.format, part.mime_type || parsedData.mimeType)
  const filename = ensureExtension(
    sanitizeFilename(part.filename || `input-audio-${uuid()}`),
    mimeType,
  )

  return {
    data: Buffer.from(parsedData.base64, 'base64'),
    filename,
    mimeType,
    coarseType: 'audio',
    fileClass: 'audio',
  }
}

function extractLocalFile(part: ChatMessageContent): NormalizedInputFile {
  const localPath = part.local_path
  if (!localPath) {
    throw new Error('Missing local_path for Chat2API file content part')
  }

  const stat = statSync(localPath)
  if (!stat.isFile()) {
    throw new Error(`Chat2API local file is not a file: ${localPath}`)
  }

  const explicitMimeType = part.mime_type
  const filename = ensureExtension(
    sanitizeFilename(part.filename || path.basename(localPath)),
    explicitMimeType || mime.lookup(localPath) || 'application/octet-stream',
  )
  const mimeType = explicitMimeType || mime.lookup(filename) || 'application/octet-stream'
  const classification = classifyFile(String(mimeType), part.type)

  return {
    data: readFileSync(localPath),
    filename,
    mimeType: String(mimeType),
    ...classification,
  }
}

function textFromContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    validateSupportedParts(content)
    return content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
  }

  return ''
}

function collectFileParts(content: ChatMessage['content']): ChatMessageContent[] {
  if (!Array.isArray(content)) {
    return []
  }

  validateSupportedParts(content)
  return content.filter(part => ['image_url', 'file', 'input_audio', 'video_url'].includes(part.type))
}

function formatRoleText(role: string, content: string): string {
  return content ? `${role}: ${content}` : `${role}:`
}

function buildQwenAiTranscript(messages: ChatMessage[]): { content: string; fileParts: ChatMessageContent[] } {
  const toolProfile = getProviderToolProfile('qwen')
  const transcriptParts: string[] = []
  const fileParts: ChatMessageContent[] = []

  for (const msg of messages) {
    const text = textFromContent(msg.content)

    if (msg.role === 'system') {
      if (text) {
        transcriptParts.push(formatRoleText('System', text))
      }
      continue
    }

    if (msg.role === 'user') {
      const messageFileParts = collectFileParts(msg.content)
      fileParts.push(...messageFileParts)
      if (text || messageFileParts.length > 0) {
        transcriptParts.push(formatRoleText('User', text))
      }
      continue
    }

    if (msg.role === 'assistant') {
      const assistantParts: string[] = []
      if (text) {
        assistantParts.push(formatRoleText('Assistant', text))
      }
      if (msg.tool_calls?.length) {
        assistantParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }))))
      }
      if (assistantParts.length > 0) {
        transcriptParts.push(assistantParts.join('\n'))
      }
      continue
    }

    if (msg.role === 'tool') {
      if (msg.tool_call_id) {
        transcriptParts.push([
          `Tool result for ${msg.tool_call_id} (already executed by the client):`,
          toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: text,
          }),
          'Use this result to continue. Do not repeat the same tool call unless the user request still cannot be satisfied from the result.',
        ].join('\n'))
      } else if (text) {
        transcriptParts.push(formatRoleText('Tool', text))
      }
    }
  }

  return {
    content: transcriptParts.join('\n\n'),
    fileParts,
  }
}

function validateSupportedParts(content: ChatMessageContent[]): void {
  for (const part of content) {
    if (!['text', 'image_url', 'file', 'input_audio', 'video_url'].includes(part.type)) {
      throw new Error(`Unsupported Qwen AI message content part type: ${part.type}`)
    }
  }
}

function extractPartUrl(part: ChatMessageContent): string {
  if (part.type === 'image_url' && part.image_url?.url) {
    return part.image_url.url
  }

  if (part.type === 'file' && part.file_url?.url) {
    return part.file_url.url
  }

  if (part.type === 'video_url' && part.video_url?.url) {
    return part.video_url.url
  }

  throw new Error(`Missing URL for ${part.type} content part`)
}

function normalizeStsResponse(data: any): QwenStsInfo {
  const source = data?.data || data || {}

  const filePath = source.file_path || source.filePath || source.path || ''
  const fileId = source.file_id || source.fileId || source.id || ''
  const fileUrl = source.file_url || source.fileUrl || source.url || source.cdn_url || ''

  const sts: QwenStsInfo = {
    accessKeyId: source.access_key_id || source.accessKeyId || source.AccessKeyId || '',
    accessKeySecret: source.access_key_secret || source.accessKeySecret || source.AccessKeySecret || '',
    securityToken: source.security_token || source.securityToken || source.SecurityToken,
    bucket: source.bucketname || source.bucket || source.bucketName || '',
    region: source.region || '',
    endpoint: source.endpoint || '',
    fileId,
    filePath,
    fileUrl,
  }

  if (!sts.accessKeyId || !sts.accessKeySecret || !sts.bucket || !sts.endpoint || !sts.filePath || !sts.fileId) {
    throw new Error('Qwen AI upload STS response is missing required fields')
  }

  return sts
}

function createQwenFileItem(file: NormalizedInputFile, sts: QwenStsInfo): any {
  const now = Date.now()
  const fileUrl = sts.fileUrl || file.sourceUrl || ''
  const type = file.coarseType

  return {
    id: sts.fileId,
    itemId: uuid(),
    type,
    url: fileUrl,
    name: file.filename,
    collection_name: '',
    progress: 100,
    status: 'uploaded',
    greenNet: 'success',
    size: file.data.length,
    error: '',
    filetype: file.coarseType,
    file_type: file.mimeType,
    showType: type,
    file_class: file.fileClass,
    uploadStatus: 'success',
    meta: {
      name: file.filename,
      size: file.data.length,
      content_type: file.mimeType,
    },
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id: sts.fileId,
      user_id: '',
      meta: {
        name: file.filename,
        size: file.data.length,
        content_type: file.mimeType,
      },
      update_at: now,
      name: file.filename,
      size: file.data.length,
      type: file.mimeType,
      url: fileUrl,
    },
  }
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream'
}

function isTextDocument(file: NormalizedInputFile): boolean {
  if (file.fileClass !== 'document') {
    return false
  }

  const mimeType = normalizeMimeType(file.mimeType)
  if (mimeType.startsWith('text/') || TEXT_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return true
  }

  return TEXT_DOCUMENT_EXTENSIONS.has(path.extname(file.filename).toLowerCase())
}

function decodeEvidenceText(file: NormalizedInputFile): { text: string; truncated: boolean } | undefined {
  if (!isTextDocument(file)) {
    return undefined
  }

  const byteLimit = Math.min(DOCUMENT_EVIDENCE_MAX_TEXT_BYTES, file.data.length)
  const truncated = file.data.length > byteLimit
  const data = truncated
    ? Buffer.concat([
        file.data.subarray(0, Math.floor(byteLimit / 2)),
        Buffer.from('\n\n[... middle of document omitted from local evidence extraction ...]\n\n'),
        file.data.subarray(file.data.length - Math.ceil(byteLimit / 2)),
      ])
    : file.data
  const text = data
    .toString('utf8')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  const suspiciousChars = (text.match(/\uFFFD/g) || []).length
  if (text.length > 0 && suspiciousChars / text.length > 0.02) {
    return undefined
  }

  return { text, truncated }
}

function uniqueTerms(values: string[]): string[] {
  const terms = new Set<string>()

  for (const value of values) {
    const normalized = value.toLowerCase()
    if (normalized.length < 3 || COMMON_QUERY_TERMS.has(normalized)) {
      continue
    }
    terms.add(normalized)
    if (terms.size >= 96) {
      break
    }
  }

  return [...terms]
}

function extractQueryTerms(queryText: string): string[] {
  const rawTokens = queryText.match(/[A-Za-z][A-Za-z0-9_.-]{2,80}|[\p{Script=Han}]{2,}/gu) || []
  const expanded = rawTokens.flatMap((token) => {
    const camelSplit = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    return [
      token,
      ...camelSplit.split(/[^A-Za-z0-9\u4e00-\u9fff]+/u),
    ]
  })

  return uniqueTerms(expanded)
}

function trimSnippet(text: string, maxChars = DOCUMENT_EVIDENCE_SNIPPET_CHARS): string {
  const compact = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

  if (compact.length <= maxChars) {
    return compact
  }

  return `${compact.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n[... truncated ...]`
}

function createWindowSnippet(text: string, start: number, end: number): string {
  const before = Math.max(0, start - Math.floor(DOCUMENT_EVIDENCE_SNIPPET_CHARS / 3))
  const after = Math.min(text.length, end + Math.floor(DOCUMENT_EVIDENCE_SNIPPET_CHARS / 2))
  const windowStart = text.lastIndexOf('\n', before)
  const windowEnd = text.indexOf('\n', after)
  const boundedStart = windowStart >= 0 ? windowStart + 1 : before
  const boundedEnd = windowEnd >= 0 ? windowEnd : after

  return trimSnippet(text.slice(boundedStart, boundedEnd))
}

function countTermMatches(lineLower: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (lineLower.includes(term) ? 1 : 0), 0)
}

function isBetterCandidate(candidate: CandidateInput, existing: DocumentCandidateSnippet): boolean {
  return candidate.priority > existing.priority
    || (candidate.priority === existing.priority && candidate.position < existing.position)
}

function findWorstCandidateIndex(candidates: DocumentCandidateSnippet[]): number {
  let worstIndex = 0

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const worst = candidates[worstIndex]
    if (
      candidate.priority < worst.priority
      || (candidate.priority === worst.priority && candidate.position > worst.position)
    ) {
      worstIndex = index
    }
  }

  return worstIndex
}

function pushBoundedCandidate(
  candidates: DocumentCandidateSnippet[],
  text: string,
  input: CandidateInput,
): void {
  if (candidates.length >= DOCUMENT_EVIDENCE_MAX_CANDIDATES) {
    const worstIndex = findWorstCandidateIndex(candidates)
    if (!isBetterCandidate(input, candidates[worstIndex])) {
      return
    }

    candidates[worstIndex] = {
      priority: input.priority,
      position: input.position,
      label: input.label,
      text: createWindowSnippet(text, input.start, input.end),
    }
    return
  }

  candidates.push({
    priority: input.priority,
    position: input.position,
    label: input.label,
    text: createWindowSnippet(text, input.start, input.end),
  })
}

function collectStructuredCandidates(text: string, terms: string[]): DocumentCandidateSnippet[] {
  const candidates: DocumentCandidateSnippet[] = []
  let lineStart = 0

  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const rawLine = match[0]
    if (!rawLine) {
      break
    }

    const line = rawLine.replace(/\n$/, '')
    const lineEnd = lineStart + line.length
    const lineLower = line.toLowerCase()
    const termMatches = countTermMatches(lineLower, terms)
    const hasKeyValue = KEY_VALUE_LINE_PATTERN.test(line)
    const hasPathValue = PATH_VALUE_PATTERN.test(line)

    if (hasKeyValue || hasPathValue || termMatches > 0) {
      const priority = (hasPathValue ? 120 : 0)
        + (hasKeyValue ? 90 : 0)
        + Math.min(termMatches, 6) * 18
      pushBoundedCandidate(candidates, text, {
        priority,
        position: lineStart,
        label: hasKeyValue || hasPathValue ? 'structured excerpt' : 'matching excerpt',
        start: lineStart,
        end: lineEnd,
      })
    }

    lineStart = lineEnd + 1
    if (lineStart >= text.length) {
      break
    }
  }

  return candidates
}

function collectPathContextCandidates(text: string): DocumentCandidateSnippet[] {
  const candidates: DocumentCandidateSnippet[] = []

  for (const match of text.matchAll(PATH_VALUE_CONTEXT_PATTERN)) {
    const start = match.index ?? 0
    pushBoundedCandidate(candidates, text, {
      priority: 110,
      position: start,
      label: 'path-like excerpt',
      start,
      end: start + match[0].length,
    })
  }

  return candidates
}

function collectKeyValueContextCandidates(text: string, terms: string[]): DocumentCandidateSnippet[] {
  const candidates: DocumentCandidateSnippet[] = []

  for (const match of text.matchAll(KEY_VALUE_CONTEXT_PATTERN)) {
    const raw = match[0]
    const start = match.index ?? 0
    const priority = 95 + Math.min(countTermMatches(raw.toLowerCase(), terms), 6) * 18
    pushBoundedCandidate(candidates, text, {
      priority,
      position: start,
      label: 'key-value excerpt',
      start,
      end: start + raw.length,
    })
  }

  return candidates
}

function dedupeCandidates(candidates: DocumentCandidateSnippet[]): DocumentCandidateSnippet[] {
  const seen = new Set<string>()
  const unique: DocumentCandidateSnippet[] = []

  for (const candidate of candidates) {
    const key = candidate.text.replace(/\s+/g, ' ').slice(0, 500)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(candidate)
  }

  return unique
}

function selectEvidenceSnippets(text: string, queryText: string): string[] {
  const terms = extractQueryTerms(queryText)
  const baseCandidates: DocumentCandidateSnippet[] = [
    {
      priority: 40,
      position: 0,
      label: 'document beginning',
      text: trimSnippet(text.slice(0, DOCUMENT_EVIDENCE_SNIPPET_CHARS)),
    },
    {
      priority: 35,
      position: Math.max(0, text.length - DOCUMENT_EVIDENCE_SNIPPET_CHARS),
      label: 'document ending',
      text: trimSnippet(text.slice(Math.max(0, text.length - DOCUMENT_EVIDENCE_SNIPPET_CHARS))),
    },
  ]
  const ranked = dedupeCandidates([
    ...baseCandidates,
    ...collectStructuredCandidates(text, terms),
    ...collectKeyValueContextCandidates(text, terms),
    ...collectPathContextCandidates(text),
  ]).sort((a, b) => (b.priority - a.priority) || (a.position - b.position))

  let usedChars = 0
  const selected: string[] = []

  for (const candidate of ranked) {
    if (!candidate.text) {
      continue
    }
    const rendered = `- ${candidate.label}:\n${candidate.text}`
    if (usedChars + rendered.length > DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS) {
      continue
    }
    selected.push(rendered)
    usedChars += rendered.length
    if (selected.length >= 12) {
      break
    }
  }

  return selected
}

function createDocumentEvidence(file: NormalizedInputFile, queryText: string): QwenAiDocumentEvidence | undefined {
  const decoded = decodeEvidenceText(file)
  if (!decoded) {
    return undefined
  }

  const snippets = selectEvidenceSnippets(decoded.text, queryText)
  if (snippets.length === 0) {
    return undefined
  }

  return {
    filename: file.filename,
    mimeType: normalizeMimeType(file.mimeType),
    textBytes: file.data.length,
    truncated: decoded.truncated,
    snippets,
  }
}

function renderDocumentEvidence(evidences: QwenAiDocumentEvidence[]): string {
  let usedChars = 0
  const renderedDocuments: string[] = []

  for (const evidence of evidences) {
    const snippets = evidence.snippets.join('\n\n')
    const rendered = [
      `Document: ${evidence.filename}`,
      `MIME: ${evidence.mimeType}; bytes: ${evidence.textBytes}; local evidence truncated: ${evidence.truncated ? 'yes' : 'no'}`,
      snippets,
    ].join('\n')

    if (usedChars + rendered.length > DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS) {
      break
    }

    renderedDocuments.push(rendered)
    usedChars += rendered.length
  }

  if (renderedDocuments.length === 0) {
    return ''
  }

  return [
    QWEN_AI_DOCUMENT_EVIDENCE_MARKER,
    'The following excerpts are copied from attached text documents to keep relevant values near this request. Treat them as evidence from the attachments, not as generated tool arguments. Use only values that are present in the excerpts or the attached documents.',
    renderedDocuments.join('\n\n---\n\n'),
    '[/Attached document evidence]',
  ].join('\n')
}

export class QwenAiFileUploader {
  private readonly axiosInstance: AxiosInstance
  private readonly getHeaders: HeaderFactory
  private readonly postWithRefreshRetry?: QwenPostWithRetry

  constructor(
    axiosInstance: AxiosInstance,
    getHeaders: HeaderFactory,
    postWithRefreshRetry?: QwenPostWithRetry,
  ) {
    this.axiosInstance = axiosInstance
    this.getHeaders = getHeaders
    this.postWithRefreshRetry = postWithRefreshRetry
  }

  async uploadPart(part: ChatMessageContent, evidenceQueryText = ''): Promise<UploadedQwenAiPart> {
    const file = await this.resolveFile(part)

    if (file.data.length > MAX_FILE_SIZE) {
      throw new Error(`Qwen AI file upload exceeds ${MAX_FILE_SIZE} bytes: ${file.filename}`)
    }

    const evidence = createDocumentEvidence(file, evidenceQueryText)

    const sts = await this.requestSts(file)
    await this.uploadToOss(file, sts)

    if (file.fileClass === 'document') {
      await this.parseDocument(sts.fileId)
    }

    return {
      file: createQwenFileItem(file, sts),
      evidence,
    }
  }

  private async resolveFile(part: ChatMessageContent): Promise<NormalizedInputFile> {
    if (part.type === 'input_audio') {
      return extractInputAudio(part)
    }

    const url = extractPartUrl(part)
    const explicitFilename = part.filename
    const explicitMimeType = part.mime_type

    if (isChat2ApiFileUrl(url)) {
      return extractLocalFile(part)
    }

    if (isDataUrl(url)) {
      return extractDataUrl(url, explicitFilename, explicitMimeType, part.type)
    }

    if (!isHttpUrl(url)) {
      throw new Error(`Unsupported Qwen AI file URL scheme for ${part.type}`)
    }

    const response = await this.axiosInstance.get(url, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_FILE_SIZE,
      maxBodyLength: MAX_FILE_SIZE,
      timeout: 60000,
      validateStatus: () => true,
    })

    if (response.status >= 400) {
      throw new Error(`Failed to download Qwen AI input file: HTTP ${response.status}`)
    }

    const headerFilename = filenameFromContentDisposition(response.headers?.['content-disposition'])
    const filename = sanitizeFilename(explicitFilename || headerFilename || filenameFromUrl(url))
    const mimeType = explicitMimeType || response.headers?.['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    const safeFilename = ensureExtension(filename, mimeType)
    const classification = classifyFile(String(mimeType), part.type)

    return {
      data: Buffer.from(response.data),
      filename: safeFilename,
      mimeType: String(mimeType),
      sourceUrl: url,
      ...classification,
    }
  }

  private async requestSts(file: NormalizedInputFile): Promise<QwenStsInfo> {
    const response = await this.postJson(
      `${QWEN_AI_BASE}/api/v2/files/getstsToken`,
      {
        filename: file.filename,
        filesize: String(file.data.length),
        filetype: file.coarseType,
      },
      () => ({
        headers: this.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      }),
    )

    if (response.status >= 400) {
      throw new Error(`Qwen AI upload STS request failed: HTTP ${response.status}`)
    }

    return normalizeStsResponse(response.data)
  }

  private async uploadToOss(file: NormalizedInputFile, sts: QwenStsInfo): Promise<void> {
    const client = new OSS({
      accessKeyId: sts.accessKeyId,
      accessKeySecret: sts.accessKeySecret,
      stsToken: sts.securityToken,
      bucket: sts.bucket,
      region: sts.region,
      endpoint: sts.endpoint,
      authorizationV4: true,
    } as any)

    await client.put(sts.filePath, file.data, {
      headers: {
        'Content-Type': file.mimeType,
      },
    } as any)
  }

  private async parseDocument(fileId: string): Promise<void> {
    const parseResponse = await this.postJson(
      `${QWEN_AI_BASE}/api/v2/files/parse`,
      { file_id: fileId },
      () => ({
        headers: this.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      }),
    )

    if (parseResponse.status >= 400) {
      throw new Error(`Qwen AI file parse request failed: HTTP ${parseResponse.status}`)
    }

    await this.waitForParse(fileId)
  }

  private async waitForParse(fileId: string): Promise<void> {
    const deadline = Date.now() + PARSE_POLL_TIMEOUT_MS
    let lastStatus = ''

    while (Date.now() < deadline) {
      await delay(PARSE_POLL_INTERVAL_MS)

      const response: AxiosResponse = await this.postJson(
        `${QWEN_AI_BASE}/api/v2/files/parse/status`,
        { file_id_list: [fileId] },
        () => ({
          headers: this.getHeaders(),
          timeout: 30000,
          validateStatus: () => true,
        }),
      )

      if (response.status >= 400) {
        throw new Error(`Qwen AI file parse status request failed: HTTP ${response.status}`)
      }

      const status = response.data?.data?.[fileId]?.status
        || response.data?.data?.[0]?.status
        || response.data?.[fileId]?.status
        || response.data?.status

      const normalizedStatus = status ? String(status).toLowerCase() : ''
      lastStatus = normalizedStatus

      if (!normalizedStatus || ['success', 'finished', 'done', 'parsed', 'completed'].includes(normalizedStatus)) {
        return
      }

      if (['failed', 'error', 'fail'].includes(normalizedStatus)) {
        throw new Error(`Qwen AI file parse failed for uploaded document: ${normalizedStatus}`)
      }
    }

    throw new Error(
      `Qwen AI file parse timed out after ${PARSE_POLL_TIMEOUT_MS}ms${lastStatus ? ` (last status: ${lastStatus})` : ''}`,
    )
  }

  private async postJson(
    url: string,
    payload: unknown,
    createOptions: () => Record<string, any>,
  ): Promise<AxiosResponse> {
    if (this.postWithRefreshRetry) {
      return this.postWithRefreshRetry(url, payload, createOptions)
    }

    return this.axiosInstance.post(url, payload, createOptions())
  }
}

export async function prepareQwenAiMultimodalMessage(
  messages: ChatMessage[],
  uploader: QwenAiFileUploader,
): Promise<PreparedQwenAiMessage> {
  const { content: userContent, fileParts } = buildQwenAiTranscript(messages)

  const files: any[] = []
  const evidences: QwenAiDocumentEvidence[] = []
  for (const part of fileParts) {
    const uploaded = await uploader.uploadPart(part, userContent)
    files.push(uploaded.file)
    if (uploaded.evidence) {
      evidences.push(uploaded.evidence)
    }
  }

  const documentEvidence = renderDocumentEvidence(evidences)
  const content = documentEvidence
    ? `${userContent}\n\n${documentEvidence}`
    : userContent

  return {
    content,
    files,
  }
}
