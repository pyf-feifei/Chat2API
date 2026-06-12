import axios, { AxiosInstance, AxiosResponse } from 'axios'
import OSS from 'ali-oss'
import mime from 'mime-types'
import path from 'path'
import type { ChatMessage, ChatMessageContent } from '../types'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const MAX_FILE_SIZE = 2000 * 1024 * 1024
const PARSE_POLL_INTERVAL_MS = 1000
const PARSE_POLL_ATTEMPTS = 5

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

export class QwenAiFileUploader {
  constructor(
    private readonly axiosInstance: AxiosInstance,
    private readonly getHeaders: HeaderFactory,
    private readonly postWithRefreshRetry?: QwenPostWithRetry,
  ) {}

  async uploadPart(part: ChatMessageContent): Promise<any> {
    const file = await this.resolveFile(part)

    if (file.data.length > MAX_FILE_SIZE) {
      throw new Error(`Qwen AI file upload exceeds ${MAX_FILE_SIZE} bytes: ${file.filename}`)
    }

    const sts = await this.requestSts(file)
    await this.uploadToOss(file, sts)

    if (file.fileClass === 'document') {
      await this.parseDocument(sts.fileId)
    }

    return createQwenFileItem(file, sts)
  }

  private async resolveFile(part: ChatMessageContent): Promise<NormalizedInputFile> {
    if (part.type === 'input_audio') {
      return extractInputAudio(part)
    }

    const url = extractPartUrl(part)
    const explicitFilename = part.filename
    const explicitMimeType = part.mime_type

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
      console.warn('[QwenAI] File parse request failed:', parseResponse.status)
      return
    }

    await this.waitForParse(fileId)
  }

  private async waitForParse(fileId: string): Promise<void> {
    for (let attempt = 0; attempt < PARSE_POLL_ATTEMPTS; attempt++) {
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
        console.warn('[QwenAI] File parse status request failed:', response.status)
        return
      }

      const status = response.data?.data?.[fileId]?.status
        || response.data?.data?.[0]?.status
        || response.data?.[fileId]?.status
        || response.data?.status

      if (!status || ['success', 'finished', 'done', 'parsed'].includes(String(status).toLowerCase())) {
        return
      }

      if (['failed', 'error'].includes(String(status).toLowerCase())) {
        console.warn('[QwenAI] File parse failed for uploaded document')
        return
      }
    }
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
  let systemContent = ''
  let userContent = ''
  const fileParts: ChatMessageContent[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = textFromContent(msg.content)
      if (text) {
        systemContent += (systemContent ? '\n\n' : '') + text
      }
      continue
    }

    if (msg.role === 'user') {
      userContent = textFromContent(msg.content)
      fileParts.splice(0, fileParts.length, ...collectFileParts(msg.content))
    }
  }

  if (systemContent) {
    userContent = `${systemContent}\n\nUser: ${userContent}`
  }

  const files: any[] = []
  for (const part of fileParts) {
    files.push(await uploader.uploadPart(part))
  }

  return {
    content: userContent,
    files,
  }
}
