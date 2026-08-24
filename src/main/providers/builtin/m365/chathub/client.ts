/**
 * ChatHub WebSocket Client
 *
 * Work/school accounts talk SignalR over wss://substrate.office.com/m365Copilot/Chathub.
 *
 * Consumer (personal MSA) accounts use copilot.microsoft.com/c/api/chat, an
 * endpoint guarded by Cloudflare bot scoring that challenges direct Node
 * sockets regardless of token validity; those are served through the
 * browser bridge (see ./browserBridge) which runs the WebSocket inside a
 * real Chrome tab.
 */
import { randomUUID } from 'crypto'
import { MSA_CONSUMER_TID } from '../auth/config'
import type {
  ChatHubAccount,
  ChatRequest,
  ChatResult,
  StreamHandler,
} from './types'
import { CopilotWebBridge } from './browserBridge'

// Work/school substrate endpoint (SignalR protocol).
const WS_BASE_WORK = 'wss://substrate.office.com/m365Copilot/Chathub'
const DEFAULT_TONE = 'magic'

// Feature variants required by the work/school ChatHub.
const VARIANTS = [
  'EnableMcpServerWidgets',
  'feature.EnableMcpServerWidgets',
  'feature.EnableLuForChatCIQ',
  'feature.enableChatCIQPlugin',
  'EnableRequestPlugins',
  'feature.EnableSensitivityLabels',
  'EnableUnsupportedUrlDetector',
  'feature.IsCustomEngineCopilotEnabled',
  'feature.bizchatfluxv3',
  'feature.enablechatpages',
  'feature.enableCodeCanvas',
  'feature.turnOnWorkTabRecommendation',
  'turnOffWorkTabUpsellFromClient',
  'feature.turnOnDARecommendation',
  'feature.IsStreamingModeInChatRequestEnabled',
  'IncludeSourceAttributionsConcise',
  'SkipPublishEmptyMessage',
  'feature.EnableDeduplicatingSourceAttributions',
  'Enable3PActionProgressMessages',
  'feature.enableClientWebRtc',
  'feature.EnableMeetingRecapOfSeriesMeetingWithCiq',
  'feature.EnableReferencesListCompleteSignal',
  'feature.StorageMessageSplitDisabled',
  'feature.EnableCuaTakeControlApi',
  'feature.cwcallowedos',
  'feature.disabledisallowedmsgs',
  'feature.enableCitationsForSynthesisData',
  'feature.enableGenerateGraphicArtOptionsSet',
  'cdximagen',
  'feature.EnableUpdatedUXForConfirmationDialog',
  'feature.EnableClientFileURLSupportForOfficeWebPaidCopilot',
  'feature.EnableDesignEditorImageGrounding',
  'feature.EnableDesignerEditor',
  'feature.OfficeWebToHelix',
  'feature.OfficeDesktopToHelix',
  'feature.M365TeamsHubToHelix',
  'feature.OwaHubToHelix',
  'feature.MonarchHubToHelix',
  'feature.Win32OutlookHubToHelix',
  'feature.MacOutlookHubToHelix',
  'Agt_bizchat_enableGpt5ForHelix',
].join(',')

function isConsumerTid(tid: string | undefined): boolean {
  return !!tid && tid === MSA_CONSUMER_TID
}

function buildWsUrl(
  account: ChatHubAccount,
  sessionId: string,
  conversationId: string,
  requestId: string,
): string {
  const params = new URLSearchParams({
    access_token: account.accessToken,
    clientId: clientIdForToken(account.accessToken),
    correlationId: requestId,
    conversationId,
    sessionId,
    oid: account.oid,
    tid: account.tid,
    variants: VARIANTS,
  })
  return `${WS_BASE_WORK}?${params.toString()}`
}

// Consumer tokens carry appid 14638111-… while commercial web
// tokens carry c0ab8ce9-…; mirror the token's own app so ChatHub accepts both.
function clientIdForToken(accessToken: string): string {
  try {
    const parts = accessToken.split('.')
    if (parts.length >= 2) {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { appid?: string }
      if (claims.appid) return claims.appid
    }
  } catch {
    // fall through to the commercial first-party client
  }
  return 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1'
}

function buildChatPayload(
  text: string,
  sessionId: string,
  conversationId: string,
  requestId: string,
  tone: string,
  firstTurn: boolean,
  attachments?: unknown[],
  tools?: unknown[],
  toolChoice?: unknown,
  mcpServerUrl?: string,
): string {
  const payload = {
    type: 4,
    target: 'chat',
    arguments: [
      {
        sessionId,
        conversationId,
        requestId,
        text,
        tone,
        firstTurn,
        attachments: attachments || [],
        tools: tools || [],
        toolChoice,
        mcpServerUrl,
      },
    ],
  }
  return JSON.stringify(payload)
}

export class ChatHubClient {
  private ws: import('ws') | null = null

  async chat(
    account: ChatHubAccount,
    request: ChatRequest,
    onDelta?: StreamHandler,
    onEvent?: StreamHandler,
  ): Promise<ChatResult> {
    if (isConsumerTid(account.tid)) {
      const bridge = await CopilotWebBridge.connect(account)
      try {
        return await bridge.chat(account, request, onDelta, onEvent)
      } finally {
        // The in-page socket is torn down inside bridge.chat().
      }
    }
    return this.chatSubstrate(account, request, onDelta, onEvent)
  }

  /** SignalR transport used by work/school accounts on substrate.office.com. */
  private async chatSubstrate(
    account: ChatHubAccount,
    request: ChatRequest,
    onDelta?: StreamHandler,
    onEvent?: StreamHandler,
  ): Promise<ChatResult> {
    const { default: WebSocket } = await import('ws')
    const { parseFrames, classifyUpdateMessages, extractToolEvents, RECORD_SEPARATOR } =
      await import('./streamParser')

    const sessionId = request.sessionId || randomUUID()
    const conversationId = request.conversationId || randomUUID()
    const requestId = randomUUID()
    const tone = request.tone || DEFAULT_TONE
    const firstTurn = request.started !== false
    const wsUrl = buildWsUrl(account, sessionId, conversationId, requestId)

    return new Promise<ChatResult>((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl, {
          headers: {
            Origin: 'https://m365.cloud.microsoft',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
          },
          handshakeTimeout: 15000,
        })

        let buffer = ''
        let streamed = ''
        const events: import('./types').StreamEvent[] = []
        const seenTools = new Set<string>()
        let reasoning = ''
        let throttling: unknown
        let handshakeComplete = false

        this.ws.on('open', () => {
          const handshake = JSON.stringify({ protocol: 'json', version: 1 }) + RECORD_SEPARATOR
          this.ws?.send(handshake)
        })

        this.ws.on('message', async (data) => {
          buffer += data.toString()
          const { frames, remainder } = parseFrames(buffer)
          buffer = remainder

          for (const frame of frames) {
            events.push(frame as import('./types').StreamEvent)
            if (typeof frame !== 'object' || frame === null) {
              continue
            }
            const obj = frame as Record<string, unknown>
            const type = obj.type

            if (!handshakeComplete && typeof type === 'undefined') {
              handshakeComplete = true
              const payload = buildChatPayload(
                request.text,
                sessionId,
                conversationId,
                requestId,
                tone,
                firstTurn,
                request.attachments,
                request.tools,
                request.toolChoice,
                request.mcpServerUrl,
              ) + RECORD_SEPARATOR
              this.ws?.send(payload)
              continue
            }

            if (type === 6) {
              this.ws?.send(JSON.stringify({ type: 6 }) + RECORD_SEPARATOR)
              continue
            }

            if (type === 1 && obj.target === 'update') {
              const args = obj.arguments
              if (!args || !Array.isArray(args)) continue

              for (const raw of args) {
                if (typeof raw !== 'object' || raw === null) continue
                const arg = raw as Record<string, unknown>

                const messages = arg.messages as unknown[] | undefined
                if (onEvent) {
                  const toolEvents = extractToolEvents(arg, seenTools)
                  for (const event of toolEvents) {
                    await onEvent(event)
                  }
                }

                const classified = classifyUpdateMessages(messages || [])
                for (const event of classified) {
                  if (event.kind === 'reasoning' && event.text) {
                    reasoning += event.text
                  }
                  if (event.kind === 'text' && event.text) {
                    const snapshot = event.text
                    if (streamed === '') {
                      streamed = snapshot
                      if (onDelta) await onDelta(event)
                    } else if (snapshot.startsWith(streamed)) {
                      const delta = snapshot.substring(streamed.length)
                      if (delta) {
                        streamed = snapshot
                        if (onDelta) await onDelta({ ...event, text: delta })
                      }
                    }
                  } else if (event.kind !== 'text' && onEvent) {
                    await onEvent(event)
                  }
                }

                if (arg.throttling) {
                  throttling = arg.throttling
                }
              }
            }

            if (type === 3) {
              this.ws?.close()
              resolve({
                text: streamed,
                reasoning: reasoning || undefined,
                conversationId,
                sessionId,
                requestId,
                throttling,
                rawResult: JSON.stringify(events),
                events,
              })
            }
          }
        })

        this.ws.on('error', (error: Error) => {
          reject(new Error(`WebSocket error: ${error.message}`))
        })

        this.ws.on('close', (code: number, reason: Buffer) => {
          if (streamed === '' && code !== 1000) {
            reject(new Error(`WebSocket closed before completion: code=${code} reason=${reason}`))
          }
        })

        setTimeout(() => {
          if (this.ws) {
            this.ws.close()
            if (streamed) {
              resolve({
                text: streamed,
                reasoning: reasoning || undefined,
                conversationId,
                sessionId,
                requestId,
                throttling,
                events,
              })
            } else {
              reject(new Error('ChatHub timeout'))
            }
          }
        }, 300000)
      } catch (error) {
        reject(error as Error)
      }
    })
  }

  close(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}