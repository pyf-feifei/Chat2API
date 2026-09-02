import axios, { type AxiosResponse } from 'axios'
import { createHash } from 'crypto'
import FormData from 'form-data'
import fs from 'fs'
import path from 'path'
import type { ChatMessage, ChatMessageContent } from '../types.ts'

const ZAI_API_BASE = 'https://chat.z.ai'
const ZAI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN',
  'Cache-Control': 'no-cache',
  Origin: ZAI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': ZAI_USER_AGENT,
  'X-Region': 'domestic',
}

export interface ZaiUploadedFile {
  id: string
  user_id: string
  hash: string | null
  filename: string
  data: Record<string, any>
  meta: {
    name: string
    content_type: string
    size: number
    cdn_url: string
    data: Record<string, any>
    oss_endpoint: string
  }
  created_at: number
  updated_at: number
}

export interface ZaiFileReference {
  type: 'file'
  file: ZaiUploadedFile
  id: string
  url: string
  name: string
  status: 'uploaded'
  size: number
  error: string
  itemId: string
  media: 'file'
  uploadedAt: number
  ref_user_msg_id: string
}

interface NormalizedInputFile {
  data?: Buffer
  localPath?: string
  sizeBytes: number
  filename: string
  mimeType: string
}

export class ZaiFileUploader {
  private token: string
  private userId: string

  constructor(token: string) {
    this.token = token
    this.userId = this.extractUserIdFromToken(token)
  }

  private extractUserIdFromToken(token: string): string {
    try {
      const parts = token.split('.')
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
        return payload.id || ''
      }
    } catch {
      // Ignore parse errors
    }
    return ''
  }

  async uploadFile(file: NormalizedInputFile): Promise<ZaiUploadedFile> {
    console.log('[Z.ai][File] Uploading file:', file.filename, 'Size:', file.sizeBytes)

    let fileData: Buffer
    if (file.data) {
      fileData = file.data
    } else if (file.localPath) {
      fileData = fs.readFileSync(file.localPath)
    } else {
      throw new Error('No file data or localPath provided')
    }

    const formData = new FormData()
    formData.append('file', fileData, {
      filename: file.filename,
      contentType: file.mimeType,
    })

    const response = await axios.post(
      `${ZAI_API_BASE}/api/v1/files/`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...FAKE_HEADERS,
          Cookie: `token=${this.token}`,
          Referer: `${ZAI_API_BASE}/`,
          ...formData.getHeaders(),
        },
        timeout: 120000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 && response.status !== 201) {
      console.error('[Z.ai][File] Upload failed:', response.status, response.data)
      throw new Error(`File upload failed: HTTP ${response.status}`)
    }

    console.log('[Z.ai][File] Upload successful:', response.data.id)
    return response.data
  }

  createFileReference(
    uploadedFile: ZaiUploadedFile,
    userMessageId: string,
  ): ZaiFileReference {
    const itemId = this.generateUuid()
    const encodedFilename = encodeURIComponent(uploadedFile.filename)

    return {
      type: 'file',
      file: uploadedFile,
      id: uploadedFile.id,
      url: `/api/v1/files/${uploadedFile.id}`,
      name: encodedFilename,
      status: 'uploaded',
      size: uploadedFile.meta.size,
      error: '',
      itemId,
      media: 'file',
      uploadedAt: uploadedFile.created_at * 1000,
      ref_user_msg_id: userMessageId,
    }
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }
}

export async function extractFileFromContent(
  part: ChatMessageContent,
): Promise<NormalizedInputFile | null> {
  if (part.type === 'file' && part.file_url?.url) {
    const url = part.file_url.url

    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+);base64,(.*)$/is)
      if (!match) {
        throw new Error('Invalid data URL format')
      }
      const mimeType = match[1]
      const data = Buffer.from(match[2], 'base64')
      const filename = part.filename || `file-${Date.now()}`
      return {
        data,
        sizeBytes: data.length,
        filename,
        mimeType,
      }
    }

    if (part.local_path) {
      const stat = fs.statSync(part.local_path)
      return {
        localPath: part.local_path,
        sizeBytes: stat.size,
        filename: part.filename || path.basename(part.local_path),
        mimeType: part.mime_type || 'application/octet-stream',
      }
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
      })
      const data = Buffer.from(response.data)
      const filename = part.filename || extractFilenameFromUrl(url)
      const mimeType = part.mime_type || response.headers['content-type'] || 'application/octet-stream'
      return {
        data,
        sizeBytes: data.length,
        filename,
        mimeType: String(mimeType).split(';')[0].trim(),
      }
    }
  }

  if (part.type === 'image_url' && part.image_url?.url) {
    const url = part.image_url.url

    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+);base64,(.*)$/is)
      if (!match) {
        throw new Error('Invalid data URL format')
      }
      const mimeType = match[1]
      const data = Buffer.from(match[2], 'base64')
      const filename = part.filename || `image-${Date.now()}`
      return {
        data,
        sizeBytes: data.length,
        filename,
        mimeType,
      }
    }

    if (part.local_path) {
      const stat = fs.statSync(part.local_path)
      return {
        localPath: part.local_path,
        sizeBytes: stat.size,
        filename: part.filename || path.basename(part.local_path),
        mimeType: part.mime_type || 'image/png',
      }
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
      })
      const data = Buffer.from(response.data)
      const filename = part.filename || extractFilenameFromUrl(url)
      const mimeType = part.mime_type || response.headers['content-type'] || 'image/png'
      return {
        data,
        sizeBytes: data.length,
        filename,
        mimeType: String(mimeType).split(';')[0].trim(),
      }
    }
  }

  return null
}

function extractFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const basename = path.basename(decodeURIComponent(parsed.pathname))
    return basename || `file-${Date.now()}`
  } catch {
    return `file-${Date.now()}`
  }
}

export function collectFileParts(content: ChatMessage['content']): ChatMessageContent[] {
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter(part => part.type === 'file' || part.type === 'image_url')
}