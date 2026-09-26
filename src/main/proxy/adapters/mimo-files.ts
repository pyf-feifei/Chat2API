import axios from 'axios'
import { createHash, randomUUID } from 'crypto'

const MIMO_API_BASE = 'https://aistudio.xiaomimimo.com'
// MiMo's web chat rejects the rendered query around 44k–52k characters.
// Leave headroom for the managed tool prompt and current turn; Codex sessions
// with many tools can otherwise pass the text-only threshold and still fail
// upstream with `query is too long`.
const DEFAULT_OFFLOAD_THRESHOLD_CHARS = 8_000
const MIN_OFFLOAD_CHARS = 2_000
const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MEDIA_MAX_ITEMS = 8
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000
const PARSE_ATTEMPTS = 3
const PARSE_RETRY_DELAY_MS = 2_000
const DEFAULT_MEDIA_PARSE_MODELS = ['mimo-v2.6-flash', 'mimo-v2.5']

export interface MimoCredentials {
  serviceToken: string
  userId: string
  phToken: string
}

export interface MimoMediaEntry {
  mediaType: 'image' | 'file'
  fileUrl: string
  compressedVideoUrl: string
  audioTrackUrl: string
  name: string
  size: number
  status: 'completed'
  objectName: string
  tokenUsage: number
  url: string
}

export interface MimoMediaInput {
  mediaType: 'image' | 'file'
  fileName: string
  mimeType: string
  data: Buffer
}

export type MimoMessageLike = {
  role: string
  content: unknown
}

export type MimoMediaCandidate =
  | { kind: 'image'; url?: string; base64?: string; mimeType?: string; fileName?: string }
  | { kind: 'file'; url?: string; base64?: string; mimeType?: string; fileName?: string }

export interface MimoSplitContent {
  text: string
  media: MimoMediaCandidate[]
}

export interface MimoOffloadPlan {
  offloadIndexes: number[]
  remainingChars: number
}

export interface MimoAttachmentResult {
  messages: MimoMessageLike[]
  multiMedias: MimoMediaEntry[]
  offloadedFiles: string[]
}

function positiveEnvInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || String(raw).trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

export function mimoFileOffloadThresholdChars(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_FILE_OFFLOAD_THRESHOLD_CHARS', DEFAULT_OFFLOAD_THRESHOLD_CHARS)
}

export function mimoMediaMaxBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_MEDIA_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES)
}

export function mimoMediaMaxItems(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_MEDIA_MAX_ITEMS', DEFAULT_MEDIA_MAX_ITEMS)
}

export function mimoUploadTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_UPLOAD_TIMEOUT_MS', DEFAULT_UPLOAD_TIMEOUT_MS)
}

export function mimoUploadSettleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_UPLOAD_SETTLE_MS', 3_000)
}

export function mimoMediaParseModels(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = String(env.MIMO_MEDIA_PARSE_MODELS || '').trim()
  if (!raw) return [...DEFAULT_MEDIA_PARSE_MODELS]
  return raw.split(',').map((value) => value.trim()).filter(Boolean)
}

function mimoParseModelChain(
  primary: string,
  env: Record<string, string | undefined>,
): string[] {
  const chain = [primary, ...mimoMediaParseModels(env)]
  return chain.filter((value, index) => value && chain.indexOf(value) === index)
}

export function mimoRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_REQUEST_TIMEOUT_MS', 300_000)
}

export function mimoQueryMaxChars(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveEnvInt(env, 'MIMO_QUERY_MAX_CHARS', 32_000)
}

export function parseMimoDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(String(url || '').trim())
  if (!match) return null
  const parameters = match[2] || ''
  if (!/;base64/i.test(parameters)) return null
  const base64 = (match[3] || '').trim()
  if (!base64) return null
  return { mimeType: match[1] || 'application/octet-stream', base64 }
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(String(value || '').trim())
}

export function extensionForMimeType(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized.includes('jpeg')) return 'jpg'
  if (normalized.includes('png')) return 'png'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('pdf')) return 'pdf'
  if (normalized.includes('markdown')) return 'md'
  if (normalized.includes('json')) return 'json'
  if (normalized.includes('yaml')) return 'yaml'
  if (normalized.includes('csv')) return 'csv'
  if (normalized.includes('html')) return 'html'
  if (normalized.includes('mpeg')) return 'mp3'
  if (normalized.includes('wav')) return 'wav'
  return 'txt'
}

export function splitMimoContentParts(content: unknown): MimoSplitContent {
  if (typeof content === 'string') return { text: content, media: [] }
  if (!Array.isArray(content)) return { text: '', media: [] }

  const texts: string[] = []
  const media: MimoMediaCandidate[] = []

  for (const rawPart of content) {
    if (typeof rawPart === 'string') {
      texts.push(rawPart)
      continue
    }
    if (!rawPart || typeof rawPart !== 'object') continue
    const part = rawPart as Record<string, unknown>
    const type = String(part.type || '')

    if (type === 'text' || type === 'input_text') {
      const text = String(part.text || '')
      if (text) texts.push(text)
      continue
    }

    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      const holder = part.image_url as Record<string, unknown> | string | undefined
      const url = typeof holder === 'string' ? holder : String(holder?.url || '')
      if (!url) continue
      const parsedDataUrl = parseMimoDataUrl(url)
      if (parsedDataUrl) {
        media.push({
          kind: 'image',
          base64: parsedDataUrl.base64,
          mimeType: parsedDataUrl.mimeType,
          fileName: part.filename ? String(part.filename) : undefined,
        })
      } else if (isHttpUrl(url)) {
        media.push({ kind: 'image', url })
      }
      continue
    }

    if (type === 'file' || type === 'input_file' || type === 'document') {
      const holder = (part.file || part) as Record<string, unknown>
      const fileName = String(holder.file_name || holder.filename || holder.name || '')
      const base64Raw = String(holder.file_data || holder.data || holder.base64 || '')
      const url = String(holder.file_url || holder.url || '')
      const mimeType = String(holder.mime_type || holder.mimeType || '')
      if (base64Raw) {
        const dataUrl = parseMimoDataUrl(base64Raw)
        media.push({
          kind: 'file',
          base64: dataUrl ? dataUrl.base64 : base64Raw,
          mimeType: dataUrl?.mimeType || mimeType || 'text/plain',
          fileName: fileName || undefined,
        })
      } else if (url && isHttpUrl(url)) {
        media.push({ kind: 'file', url, mimeType: mimeType || 'text/plain', fileName: fileName || undefined })
      }
    }
  }

  return { text: texts.join('\n'), media }
}

export function extractMimoPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const rawPart of content) {
    if (typeof rawPart === 'string') {
      texts.push(rawPart)
      continue
    }
    if (!rawPart || typeof rawPart !== 'object') continue
    const part = rawPart as Record<string, unknown>
    const type = String(part.type || '')
    if (type === 'text' || type === 'input_text') {
      const text = String(part.text || '')
      if (text) texts.push(text)
    }
  }
  return texts.join('\n')
}

export function planMimoFileOffload(
  messages: MimoMessageLike[],
  thresholdChars: number = mimoFileOffloadThresholdChars(),
  protectedIndexes: ReadonlySet<number> = new Set(),
): MimoOffloadPlan {
  const sizes = messages.map((message) => extractMimoPlainText(message.content).length)
  let remainingChars = sizes.reduce((total, size) => total + size, 0)
  if (thresholdChars <= 0 || remainingChars <= thresholdChars) {
    return { offloadIndexes: [], remainingChars }
  }

  const offloadIndexes: number[] = []
  const offloaded = new Set<number>()

  while (remainingChars > thresholdChars) {
    let candidateIndex = -1
    let candidateSize = MIN_OFFLOAD_CHARS - 1
    for (let index = 0; index < sizes.length; index += 1) {
      if (offloaded.has(index) || protectedIndexes.has(index)) continue
      if (sizes[index] > candidateSize) {
        candidateSize = sizes[index]
        candidateIndex = index
      }
    }
    if (candidateIndex === -1) {
      // A long Codex transcript can contain many small tool-result messages.
      // Once the large messages are gone, their aggregate can still exceed
      // MiMo's query ceiling. For a genuinely long transcript, continue
      // offloading the largest remaining old message even when it is below
      // the per-message minimum; short two-message requests retain the old
      // no-tiny-attachment behavior.
      if (messages.length <= 16) break
      candidateSize = 0
      for (let index = 0; index < sizes.length; index += 1) {
        if (offloaded.has(index) || protectedIndexes.has(index)) continue
        if (sizes[index] > candidateSize) {
          candidateSize = sizes[index]
          candidateIndex = index
        }
      }
      if (candidateIndex === -1) break
    }
    offloaded.add(candidateIndex)
    offloadIndexes.push(candidateIndex)
    remainingChars -= sizes[candidateIndex]
  }

  return { offloadIndexes, remainingChars }
}

function compactTextForQuery(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n\n[上下文已压缩；完整内容已保存为附件]\n\n'
  const available = Math.max(0, maxChars - marker.length)
  const headLength = Math.ceil(available * 0.55)
  const tailLength = Math.max(0, available - headLength)
  return text.slice(0, headLength) + marker + (tailLength > 0 ? text.slice(-tailLength) : '')
}

/**
 * Keep the rendered MiMo query below the web endpoint's hard limit even when
 * a long transcript contains many small messages. Offload handles the large
 * payloads; this final pass protects the active turn and the managed prompt
 * when their aggregate still exceeds the limit.
 */
export function compactMimoMessagesForQuery(
  messages: MimoMessageLike[],
  maxChars: number,
  measure: (candidate: MimoMessageLike[]) => number = candidate => candidate.reduce(
    (total, message) => total + extractMimoPlainText(message.content).length,
    0,
  ),
): { messages: MimoMessageLike[]; beforeChars: number; afterChars: number; compacted: boolean } {
  const beforeChars = measure(messages)
  if (maxChars <= 0 || beforeChars <= maxChars) {
    return { messages, beforeChars, afterChars: beforeChars, compacted: false }
  }

  let latestInstructionIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    const role = String(messages[index].role || '').toLowerCase()
    if (role === 'system' || role === 'developer') latestInstructionIndex = index
  }
  const keep = new Set<number>([messages.length - 1])
  if (latestInstructionIndex >= 0) keep.add(latestInstructionIndex)
  // Only the active turn and its immediate result are needed to continue;
  // older assistant tool-call payloads are represented by the saved
  // attachment pointer instead of being replayed verbatim.
  for (let index = Math.max(0, messages.length - 2); index < messages.length; index += 1) keep.add(index)

  let next = messages.map((message, index) => {
    if (keep.has(index)) {
      if (Array.isArray((message as { tool_calls?: unknown }).tool_calls)
        && index < messages.length - 1
      ) {
        return { role: message.role, content: '[历史工具调用已压缩；完整内容已保存为附件]' }
      }
      return { ...message }
    }
    return {
      role: message.role,
      content: '[历史上下文已压缩；完整内容已保存为附件]'
    }
  })

  let afterChars = measure(next)
  if (afterChars <= maxChars) {
    return { messages: next, beforeChars, afterChars, compacted: true }
  }

  // The managed instruction/tool contract is the one block we must not drop.
  // Trim its middle only as a last resort, retaining both the beginning and
  // the active tail so the current tool declaration remains visible.
  const defaultBudget = Math.max(2_000, Math.floor(maxChars / 8))
  const instructionBudget = Math.max(6_000, Math.floor(maxChars / 2))
  next = next.map((message, index) => {
    if (!keep.has(index)) return message
    const perMessageBudget = index === latestInstructionIndex ? instructionBudget : defaultBudget
    const renderedLength = measure([message])
    const text = extractMimoPlainText(message.content)
    if (renderedLength <= perMessageBudget && text.length <= perMessageBudget) return message
    return {
      role: message.role,
      content: compactTextForQuery(text, perMessageBudget)
    }
  })
  afterChars = measure(next)
  return { messages: next, beforeChars, afterChars, compacted: true }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Mimo upload aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Mimo upload aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function resolveMimoMediaInput(
  candidate: MimoMediaCandidate,
  options: { maxBytes: number; signal?: AbortSignal; timeoutMs: number },
): Promise<MimoMediaInput | null> {
  let data: Buffer
  let mimeType = candidate.mimeType || ''

  if (candidate.base64) {
    data = Buffer.from(candidate.base64, 'base64')
  } else if (candidate.url && isHttpUrl(candidate.url)) {
    const response = await axios.get(candidate.url, {
      responseType: 'arraybuffer',
      timeout: options.timeoutMs,
      signal: options.signal,
      validateStatus: () => true,
      maxContentLength: options.maxBytes,
    })
    if (response.status !== 200) {
      throw new Error(`Mimo media download failed (HTTP ${response.status}) for ${candidate.url.slice(0, 120)}`)
    }
    data = Buffer.from(response.data)
    if (!mimeType) {
      mimeType = String(response.headers['content-type'] || '').split(';')[0].trim()
    }
  } else {
    return null
  }

  if (data.length === 0) return null
  if (data.length > options.maxBytes) {
    throw new Error(
      `Mimo attachment is ${data.length} bytes which exceeds the ${options.maxBytes} byte limit`,
    )
  }

  const fileName = candidate.fileName
    || `${randomUUID().replace(/-/g, '')}.${extensionForMimeType(mimeType)}`

  return {
    mediaType: candidate.kind,
    fileName,
    mimeType: mimeType || (candidate.kind === 'image' ? 'image/jpeg' : 'text/plain'),
    data,
  }
}

export async function uploadMimoMedia(options: {
  credentials: MimoCredentials
  model: string
  input: MimoMediaInput
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}): Promise<MimoMediaEntry> {
  const env = options.env ?? process.env
  const timeout = mimoUploadTimeoutMs(env)
  const { serviceToken, userId, phToken } = options.credentials
  const cookie = `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`
  const jsonHeaders = {
    'Content-Type': 'application/json',
    Cookie: cookie,
    Origin: MIMO_API_BASE,
    Referer: `${MIMO_API_BASE}/`,
  }
  const md5Hex = createHash('md5').update(options.input.data).digest('hex')

  const infoResponse = await axios.post(
    `${MIMO_API_BASE}/open-apis/resource/genUploadInfo?xiaomichatbot_ph=${encodeURIComponent(phToken)}`,
    { fileName: options.input.fileName, fileContentMd5: md5Hex },
    { headers: jsonHeaders, timeout, signal: options.signal, validateStatus: () => true },
  )
  const info = infoResponse.data?.data
  if (infoResponse.status !== 200 || infoResponse.data?.code !== 0 || !info?.uploadUrl || !info?.resourceUrl) {
    throw new Error(
      `Mimo genUploadInfo failed (HTTP ${infoResponse.status}): ${infoResponse.data?.msg || infoResponse.data?.message || 'unknown error'}`,
    )
  }

  const putResponse = await axios.put(info.uploadUrl, options.input.data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-MD5': md5Hex,
    },
    timeout,
    signal: options.signal,
    validateStatus: () => true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })
  if (putResponse.status !== 200) {
    throw new Error(`Mimo attachment upload failed (HTTP ${putResponse.status})`)
  }

  let parsed: { data?: { id?: string; tokenUsage?: number } } | null = null
  let lastFailure = ''
  for (const parseModel of mimoParseModelChain(options.model, env)) {
    for (let attempt = 0; attempt < PARSE_ATTEMPTS && !parsed; attempt += 1) {
      if (attempt > 0) await delay(PARSE_RETRY_DELAY_MS, options.signal)
      const parseResponse = await axios.post(
        `${MIMO_API_BASE}/open-apis/resource/parse`
        + `?fileUrl=${encodeURIComponent(info.resourceUrl)}`
        + `&objectName=${encodeURIComponent(info.objectName)}`
        + `&model=${encodeURIComponent(parseModel)}`
        + `&xiaomichatbot_ph=${encodeURIComponent(phToken)}`,
        {},
        { headers: jsonHeaders, timeout, signal: options.signal, validateStatus: () => true },
      )
      if (parseResponse.status === 200 && parseResponse.data?.code === 0 && parseResponse.data?.data?.id) {
        parsed = parseResponse.data
        break
      }
      lastFailure = `model ${parseModel} HTTP ${parseResponse.status} ${parseResponse.data?.msg || ''}`.trim()
      if (parseResponse.data?.code && Number.parseInt(String(parseResponse.data.code), 10) >= 6000) {
        break
      }
    }
    if (parsed) break
  }
  if (!parsed?.data?.id) {
    throw new Error(`Mimo resource/parse did not return a resource id (${lastFailure || 'no response'})`)
  }

  const settleMs = mimoUploadSettleMs(env)
  if (settleMs > 0) {
    await delay(settleMs, options.signal)
  }

  return {
    mediaType: options.input.mediaType,
    fileUrl: info.resourceUrl,
    compressedVideoUrl: '',
    audioTrackUrl: '',
    name: options.input.fileName,
    size: options.input.data.length,
    status: 'completed',
    objectName: info.objectName,
    tokenUsage: Number(parsed.data.tokenUsage || 0),
    url: String(parsed.data.id),
  }
}

export async function prepareMimoAttachments(options: {
  messages: MimoMessageLike[]
  credentials: MimoCredentials
  model: string
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}): Promise<MimoAttachmentResult> {
  const env = options.env ?? process.env
  const maxBytes = mimoMediaMaxBytes(env)
  const maxItems = mimoMediaMaxItems(env)
  const timeout = mimoUploadTimeoutMs(env)

  const messages: MimoMessageLike[] = []
  const mediaInputs: MimoMediaInput[] = []

  for (const message of options.messages) {
    const parts = splitMimoContentParts(message.content)
    if (parts.media.length === 0) {
      messages.push(message)
      continue
    }
    messages.push({ ...message, content: parts.text })
    for (const candidate of parts.media) {
      if (mediaInputs.length >= maxItems) {
        console.warn('[Mimo] attachment limit reached, ignoring extra media parts')
        break
      }
      const input = await resolveMimoMediaInput(candidate, { maxBytes, signal: options.signal, timeoutMs: timeout })
      if (input) mediaInputs.push(input)
    }
  }

  const multiMedias: MimoMediaEntry[] = []
  for (const input of mediaInputs) {
    multiMedias.push(await uploadMimoMedia({
      credentials: options.credentials,
      model: options.model,
      input,
      signal: options.signal,
      env,
    }))
  }

  const offloadedFiles: string[] = []
  const protectedIndexes = new Set<number>()
  let latestInstructionIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    const role = String(messages[index].role || '').toLowerCase()
    if (role === 'system' || role === 'developer') latestInstructionIndex = index
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const text = extractMimoPlainText(message.content)
    if (
      index === latestInstructionIndex
      || (/##\s*Available Tools/i.test(text) && index >= latestInstructionIndex - 1)
      || index === messages.length - 1
    ) {
      protectedIndexes.add(index)
    }
  }
  const plan = planMimoFileOffload(
    messages,
    mimoFileOffloadThresholdChars(env),
    protectedIndexes,
  )
  if (plan.offloadIndexes.length > 0) {
    const next = [...messages]
    for (const index of plan.offloadIndexes) {
      const original = next[index]
      const text = extractMimoPlainText(original.content)
      if (!text) continue
      const fileName = `chat2api-context-${index + 1}.md`
      try {
        const entry = await uploadMimoMedia({
          credentials: options.credentials,
          model: options.model,
          input: {
            mediaType: 'file',
            fileName,
            mimeType: 'text/markdown',
            data: Buffer.from(text, 'utf8'),
          },
          signal: options.signal,
          env,
        })
        multiMedias.push(entry)
        offloadedFiles.push(fileName)
        next[index] = {
          ...original,
          content: `[长上下文已上传为附件 ${fileName}（${entry.size} 字节），完整内容见该文件。]`,
        }
      } catch (error) {
        console.warn(
          '[Mimo] context offload failed, keeping inline text:',
          error instanceof Error ? error.message : error,
        )
      }
    }
    return { messages: next, multiMedias, offloadedFiles }
  }

  return { messages, multiMedias, offloadedFiles }
}
