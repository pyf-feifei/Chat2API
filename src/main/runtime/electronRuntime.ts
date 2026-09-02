import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { createDecipheriv, createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { RuntimeAdapter } from './types'
import { ENCRYPTION_PREFIX } from './types'

export const electronRuntime: RuntimeAdapter = {
  kind: 'electron',

  getDataDir(): string {
    return join(homedir(), '.chat2api')
  },

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },

  encryptString(value: string): string {
    return Buffer.from(safeStorage.encryptString(value)).toString('base64')
  },

  decryptString(value: string): string {
    if (value.startsWith(ENCRYPTION_PREFIX)) {
      const secret = process.env.CHAT2API_STORAGE_ENCRYPTION_KEY
      if (secret) {
        try {
          const key = createHash('sha256').update(secret).digest()
          const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64')
          const iv = payload.subarray(0, 12)
          const tag = payload.subarray(12, 28)
          const encrypted = payload.subarray(28)
          const decipher = createDecipheriv('aes-256-gcm', key, iv)
          decipher.setAuthTag(tag)
          return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
        } catch {}
      }
    }
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  },

  getResourcePath(fileName: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, fileName)
    }

    return join(app.getAppPath(), fileName)
  },

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url)
  },

  notify(channel: string, payload: unknown): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, payload)
    })
  },
}
