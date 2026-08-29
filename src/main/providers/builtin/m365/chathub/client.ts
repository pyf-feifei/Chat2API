/**
 * ChatHub WebSocket Client
 *
 * All accounts talk SignalR over wss://substrate.office.com/m365Copilot/Chathub.
 *
 * - Work/school accounts use the commercial query/payload shape.
 * - Consumer (personal MSA) accounts use the officeweb shape mirrored from
 *   the m365.cloud.microsoft web client (licenseType=Starter,
 *   scenario=OfficeWebIncludedCopilot), so no browser/CDP bridge is involved
 *   and every account opens its own socket (load-balancer friendly).
 */
import { randomUUID } from 'crypto'
import { MSA_CONSUMER_TID } from '../auth/config'
import type {
  ChatHubAccount,
  ChatRequest,
  ChatResult,
  StreamHandler,
} from './types'

const WS_BASE = 'wss://substrate.office.com/m365Copilot/Chathub'
const DEFAULT_TONE = 'magic'
const DEFAULT_TIME_ZONE = process.env.M365_TIME_ZONE || 'Asia/Tokyo'

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

// Feature variants sent by the m365.cloud.microsoft officeweb consumer client
// (captured verbatim; the ChatHub rejects requests with unknown/missing sets).
const CONSUMER_VARIANTS = [
  'EnableMcpServerWidgets',
  'feature.EnableMcpServerWidgets',
  'feature.EnableImageGenInsufficientTokensThrottled',
  'feature.EnableImageGenSystemCapacityThrottled',
  'feature.EnableLuForChatCIQ',
  'feature.enableChatCIQPlugin',
  'EnableRequestPlugins',
  'feature.EnableSensitivityLabels',
  'EnableUnsupportedUrlDetector',
  'feature.IsCustomEngineCopilotEnabled',
  'feature.bizchatfluxv3',
  'feature.enablechatpages',
  'feature.enableCodeCanvas',
  'feature.turnOnDARecommendation',
  'feature.IsStreamingModeInChatRequestEnabled',
  'IncludeSourceAttributionsConcise',
  'SkipPublishEmptyMessage',
  'feature.EnableDeduplicatingSourceAttributions',
  'feature.IsCitationsReferencesOutputEnabled',
  'feature.enableDeltaStreamingForReferences',
  'feature.enableIncludeReferencesInDeltaResponse',
  'feature.enablereferencesforagents',
  'feature.EnableCodeInterpreterConversion',
  'agt_module_attr_enableReferencesForCodeInterpreter',
  'agt_module_enableCodeInterpreterHallucinatedUrlFilter',
  'Enable3PActionProgressMessages',
  'feature.enableClientWebRtc',
  'feature.EnableMeetingRecapOfSeriesMeetingWithCiq',
  'feature.cwcfluxv3fe',
  'feature.cwcfluxv3fem',
  'feature.EnableReferencesListCompleteSignal',
  'feature.StorageMessageSplitDisabled',
  'SingletonEnvOn',
  'cdxenablefccinmainline',
  'EnableComposeWidget',
  '-agt_researcheragent_enableMemoryRead',
  'cdxweb_search_citations_answer_cards',
  'cdxenable_strongly_typed_bing_grounding_conversion',
  'cdxweb_search_citations_video_answer_card',
  'cdxweb_search_citations_places_answer_card',
  'cdxweb_search_citations_sports_answer_card',
  'cdxweb_search_citations_weather_answer_card',
  'cdxweb_search_citations_image_answer_card',
  'agt_bizchat_enableImageListSdlCard',
  'agt_webagent_enableImageListSdlCard',
  'cdximage_sdl_card',
  'cdxshopping_berry_answer_card_msa',
  'unitab_msa_enableEducationLearningTool',
  'skds_msa_EnableGlobalIndex',
  'feature.cwcallowedos',
  'feature.EnableMergingPureDeltas',
  'feature.disabledisallowedmsgs',
  'feature.enableCitationsForSynthesisData',
  'feature.EnableConversationShareApis',
  'feature.EnableConversationShareApisForMsa',
  'feature.enableGenerateGraphicArtOptionsSet',
  'cdximagen',
  'feature.EnableUpdatedUXForConfirmationDialog',
  'feature.EnableContentApiandDocTypeHtmlInRichAnswers',
  'cdxgrounding_api_v2_rich_web_answers_reference_bottom_force',
  'cdxenablerenderforisocomp',
  'feature.EnableClientFileURLSupportForOfficeWebPaidCopilot',
  'feature.EnableDesignEditorImageGrounding',
  'feature.EnableDesignerEditor',
  'feature.EnableSkipRehydrationForSpeCIdImages',
  'feature.sourcescontrolmainline',
  'feature.sourcescontrolmainlineal',
  'feature.EnableConnectorExecutionControlsAllowlist',
  'feature.EnableBizchatMainlineExecutionControlsResolution',
  'feature.EnablePersonalizationForMSA',
  'rich_responses',
  'feature.EnableBase64DataInMessageAnnotations',
  'feature.EnableSkipEmittingMessageOnFlush',
  'feature.EnableRemoveEmptySourceAttributions',
  'feature.EnableRemoveStreamingMode',
].join(',')

// Synthetic routing tenant substrate uses for MSA consumer identities on the
// m365Copilot Chathub (observed from the officeweb client; distinct from the
// MSA tid 9188040d-鈥?.
const CONSUMER_ROUTING_TID = '84df9e7f-e9f6-40af-b435-aaaaaaaaaaaa'

// Options sets sent by the m365.cloud.microsoft officeweb consumer client
// (captured verbatim; mismatched sets yield silently ignored invocations).
const CONSUMER_OPTIONS_SETS = [
  'search_result_progress_messages_with_search_queries',
  'update_textdoc_response_after_streaming',
  'deepleo_networking_timeout_10minutes_canmore',
  'cwc_flux_image',
  'cwc_code_interpreter',
  'cwc_code_interpreter_amsfix',
  'enable_msa_user',
  'cwcgptv',
  'flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch',
  'gptvnorm2048',
  'pdnascan',
  'cwc_code_interpreter_citation_fix',
  'code_interpreter_interactive_charts',
  'cwc_code_interpreter_interactive_charts_inline_image',
  'code_interpreter_matplotlib_patching',
  'cwc_fileupload_odb',
  'update_memory_plugin',
  'add_custom_instructions',
  'cwc_flux_v3',
  'flux_v3_progress_messages',
  'enable_batch_token_processing',
  'enable_gg_gpt',
  'async_client_interaction',
  'flux_v3_references',
  'flux_v3_references_entities',
  'flux_v3_references_ci',
  'add_filestore_filetype',
  'cwc_code_interpreter_citation_sourceannotations',
  'cdxcwc_code_interpreter_hallucinated_url_filter',
  'flux_v3_image_gen_enable_non_watermarked_storage',
  'flux_v3_image_gen_enable_story',
  'rich_responses',
  'enable_strongly_typed_bing_grounding_conversion',
  'web_search_citations_answer_cards',
]

const CONSUMER_ALLOWED_MESSAGE_TYPES = [
  'Chat', 'Suggestion', 'InternalSearchQuery', 'Disengaged',
  'InternalLoaderMessage', 'Progress', 'GeneratedCode', 'RenderCardRequest',
  'AdsQuery', 'SemanticSerp', 'GenerateContentQuery', 'GenerateGraphicArt',
  'SearchQuery', 'ConfirmationCard', 'AuthError', 'DeveloperLogs',
  'TriggerPlugin', 'HintInvocation', 'MemoryUpdate', 'EndOfRequest',
  'TriggerConfirmation', 'ResumeInvokeAction', 'ResumeUserInputRequest',
  'TriggerUserInputRequest', 'EscapeHatch', 'TriggerPluginAuth',
  'ResumePluginAuth', 'SideBySide', 'ReferencesListComplete',
  'SwitchRespondingEndpoint',
]

type SubstrateVariant = 'work' | 'consumer'

function isConsumerTid(tid: string | undefined): boolean {
  return !!tid && tid === MSA_CONSUMER_TID
}

// Consumer tokens carry appid 14638111-鈥?while commercial web
// tokens carry c0ab8ce9-鈥? mirror the token's own app so ChatHub accepts both.
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

function buildWsUrl(
  account: ChatHubAccount,
  sessionId: string,
  conversationId: string,
  requestId: string,
  variant: SubstrateVariant,
): string {
  if (variant === 'consumer') {
    const routingSessionId = sessionId.replace(/-/g, '')
    const params = new URLSearchParams({
      chatsessionid: routingSessionId,
      XRoutingParameterSessionKey: routingSessionId,
      // The officeweb client reuses the routing session id here and sends the
      // source value JSON-quoted; mirror both or the hub ignores invocations.
      clientrequestid: routingSessionId,
      'X-SessionId': sessionId,
      ConversationId: conversationId,
      access_token: account.accessToken,
      variants: CONSUMER_VARIANTS,
      source: '"officeweb"',
      product: 'Office',
      agentHost: 'Bizchat.FullScreen',
      licenseType: 'Free',
      isEdu: 'false',
      agent: 'web',
      scenario: 'OfficeWebFreeConsumerCopilot',
    })
    return `${WS_BASE}/${account.oid}@${CONSUMER_ROUTING_TID}?${params.toString()}`
  }
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
  return `${WS_BASE}?${params.toString()}`
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
    customInstructions?: string,
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
        options: customInstructions ? { customInstructions: { text: customInstructions } } : {},
      },
    ],
  }
  return JSON.stringify(payload)
}

function buildConsumerChatPayload(
    text: string,
    sessionId: string,
    requestId: string,
    firstTurn: boolean,
    customInstructions?: string,
    tone?: string,
  ): string {
  // Mirrored from the m365.cloud.microsoft officeweb consumer client; the
  // ChatHub silently ignores invocations whose shape drifts too far.
  const clientInfo = {
    clientPlatform: 'mcmcopilot-web',
    clientAppName: 'Office',
    clientEntrypoint: 'mcmcopilot-officeweb',
    clientSessionId: sessionId,
    ProductCategory: 'Chat',
    clientAppType: 'Web',
    productEntryPoint: 'ChatPanel',
    deviceOS: 'Windows',
    deviceType: 'Desktop',
    clientPlatformVersion: '10',
  }
  const payload = {
    arguments: [
      {
        source: 'officeweb',
        clientCorrelationId: requestId,
        sessionId,
        optionsSets: CONSUMER_OPTIONS_SETS,
        streamingMode: 'ConciseWithPadding',
        options: customInstructions ? { customInstructions: { text: customInstructions } } : {},
        extraExtensionParameters: {},
        allowedMessageTypes: CONSUMER_ALLOWED_MESSAGE_TYPES,
        sliceIds: [],
        threadLevelGptId: {},
        traceId: requestId,
        isStartOfSession: firstTurn,
        clientInfo,
        message: {
          author: 'user',
          inputMethod: 'Keyboard',
          text,
          entityAnnotationTypes: ['People', 'File', 'Event', 'Email', 'TeamsMessage'],
          requestId,
          locationInfo: { timeZoneOffset: 9, timeZone: DEFAULT_TIME_ZONE },
          locale: 'en-us',
          messageType: 'Chat',
          experienceType: 'Default',
          adaptiveCards: [],
          clientPreferences: { executionControls: { web: {}, work: {} } },
          connectedFederatedConnections: ['dummyId'],
          clientInfo,
        },
        plugins: [{ Id: 'BingWebSearch', Source: 'BuiltIn' }],
        isSbsSupported: true,
        // Magic confabulates instead of following prompt-injected tool
        // protocols; Assist complies (validated 2026-08-28).
        tone: tone || 'Magic',
        renderReferencesBehindEOS: true,
        disconnectBehavior: 'continue',
      },
    ],
    invocationId: '0',
    target: 'chat',
    type: 4,
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
    const variant: SubstrateVariant = isConsumerTid(account.tid) ? 'consumer' : 'work'
    return this.chatSubstrate(account, request, onDelta, onEvent, variant)
  }

  /** SignalR transport used by both work/school and consumer accounts. */
  private async chatSubstrate(
    account: ChatHubAccount,
    request: ChatRequest,
    onDelta?: StreamHandler,
    onEvent?: StreamHandler,
    variant: SubstrateVariant = 'work',
  ): Promise<ChatResult> {
    const { default: WebSocket } = await import('ws')
    const { parseFrames, classifyUpdateMessages, extractToolEvents, RECORD_SEPARATOR } =
      await import('./streamParser')

    const sessionId = request.sessionId || randomUUID()
    const conversationId = request.conversationId || randomUUID()
    const requestId = randomUUID()
    const tone = request.tone || DEFAULT_TONE
    const firstTurn = request.started !== false
    const wsUrl = buildWsUrl(account, sessionId, conversationId, requestId, variant)

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
              // SignalR's text protocol needs the 0x1e terminator on every
              // frame; without it the hub silently drops the invocation.
              const payload =
                (variant === 'consumer'
                  ? buildConsumerChatPayload(request.text, sessionId, requestId, firstTurn, request.customInstructions, tone)
                  : buildChatPayload(
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
                      request.customInstructions,
                    )) + RECORD_SEPARATOR
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

                // Consumer transports interleave two channels: writeAtCursor
                // carries small incremental deltas (e.g. markdown breaks) while
                // snapshot messages carry the cumulative answer text. Reconcile
                // both by prefix so neither suppresses the other.
                const cursorDelta = variant === 'consumer' ? arg.writeAtCursor : undefined
                if (typeof cursorDelta === 'string' && cursorDelta) {
                  streamed += cursorDelta
                  if (onDelta) await onDelta({ kind: 'text', text: cursorDelta, raw: arg })
                }

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
                    if (snapshot === streamed) {
                      continue
                    }
                    if (snapshot.startsWith(streamed)) {
                      const delta = snapshot.substring(streamed.length)
                      streamed = snapshot
                      if (onDelta && delta) await onDelta({ ...event, text: delta })
                    } else if (!streamed.startsWith(snapshot)) {
                      // Diverged beyond prefix repair; adopt the canonical
                      // snapshot as baseline rather than double-emitting.
                      console.warn('[M365Copilot] snapshot diverged from streamed text; rebasing')
                      streamed = snapshot
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

            if (type === 2 && variant === 'consumer' && streamed === '') {
              const itemMessages =
                ((obj.item as Record<string, unknown> | undefined)?.messages as unknown[]) || []
              for (let i = itemMessages.length - 1; i >= 0; i--) {
                const entry = itemMessages[i] as Record<string, unknown> | undefined
                if (entry && entry.author !== 'user' && typeof entry.text === 'string' && entry.text) {
                  streamed = entry.text
                  if (onDelta) await onDelta({ kind: 'text', text: entry.text, raw: entry })
                  break
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
          // Reject immediately with the real error so upstream auth-retry
          // patterns (e.g. 401 matching in isM365AuthIssue) see it before
          // the close(1006) event fires with a non-matching message.
          reject(new Error(`WebSocket error: ${error.message}`))
          console.warn(
            '[M365Copilot] ChatHub WebSocket error:',
            JSON.stringify({
              variant,
              oid: account.oid,
              tokenLen: account.accessToken.length,
              err: error.message,
            })
          )
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

