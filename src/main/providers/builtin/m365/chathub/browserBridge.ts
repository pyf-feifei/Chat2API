/**
 * M365 Copilot consumer-account transport.
 *
 * Consumer (personal MSA) accounts chat over copilot.microsoft.com/c/api/chat,
 * a plain-JSON WebSocket API guarded by Cloudflare bot scoring. Direct Node
 * sockets get a Turnstile challenge no matter which token or cookie set is
 * used, because the verdict happens at the TLS-fingerprint level. A real
 * Chrome instance passes without any challenge, so this transport drives the
 * WebSocket *inside* a Chrome tab over CDP and bridges frames back.
 *
 * Requirements:
 *  - Chrome started with --remote-debugging-port (CHAT2API_M365_CDP_URL).
 *  - A tab open on https://copilot.microsoft.com/ signed in with the account.
 *
 * Work/school accounts keep using the SignalR transport in ./client.ts.
 */
import type {
  ChatHubAccount,
  ChatRequest,
  ChatResult,
  StreamEvent,
  StreamHandler,
} from './types'

const DEFAULT_CDP_URL = process.env.CHAT2API_M365_CDP_URL || 'http://127.0.0.1:9222'
const CONVERSATIONS_API = 'https://copilot.microsoft.com/c/api/conversations'
const ACQUIRE_AT_JS = `
(async function(){
  function parseExp(t){ try { var c = JSON.parse(atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); return c.exp || 0; } catch(e){ return 0; } }
  var now = Math.floor(Date.now()/1000);
  if (window.__m365AT && parseExp(window.__m365AT) > now + 120) return window.__m365AT;
  var fallback = __FALLBACK_AT__;
  var rt = '';
  try {
    var stores = [localStorage, sessionStorage];
    for (var si = 0; si < stores.length && !rt; si++) {
      var st = stores[si];
      try {
        for (var i = 0; i < st.length; i++) {
          var v = st.getItem(st.key(i)) || '';
          if (v.indexOf('efreshToken') < 0) continue;
          try { var o = JSON.parse(v); if (o && o.credentialType && String(o.credentialType).toLowerCase() === 'refreshtoken' && o.secret) { rt = o.secret; break; } } catch(e) {}
        }
      } catch(e) {}
    }
  } catch(e) {}
  if (rt) {
    try {
      var body = 'client_id=14638111-3389-403d-b206-a6a71d9f8f16'
        + '&grant_type=refresh_token'
        + '&refresh_token=' + encodeURIComponent(rt)
        + '&scope=' + encodeURIComponent('140e65af-45d1-4427-bf08-3e7295db6836/ChatAI.ReadWrite openid profile offline_access');
      var res = await fetch('https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
      var j = null; try { j = await res.json(); } catch(e) {}
      if (j && j.access_token) { window.__m365AT = j.access_token; return window.__m365AT; }
    } catch(e) {}
  }
  window.__m365AT = fallback;
  return window.__m365AT;
})()
`

interface BridgeFrame {
  event?: string
  type?: string
  id?: string | number
  text?: string
  messageId?: string
  partId?: string
  conversationId?: string
  title?: string
  errorCode?: string
}

export class CopilotWebBridge {
  private wsUrl: string
  private pageWs: WebSocket
  private msgId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private bindingQueue: any[] = []
  private bindingWaiter: ((v: any) => void) | null = null

  constructor(wsUrl: string, pageSocket: WebSocket) {
    this.wsUrl = wsUrl
    this.pageWs = pageSocket
  }

  static async connect(account: ChatHubAccount): Promise<CopilotWebBridge> {
    const base = process.env.CHAT2API_M365_CDP_URL || DEFAULT_CDP_URL
    const targets = await fetchJson<any[]>(`${base}/json/list`)
    const page = targets.find((t: any) => t.type === 'page' && /copilot\.microsoft\.com/.test(t.url || ''))
    if (!page) {
      throw new Error(
        'No copilot.microsoft.com tab found in the debuggable Chrome. '
        + `Open https://copilot.microsoft.com/ (signed in) in the Chrome listening on ${base}.`
      )
    }

    const ws: WebSocket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')), { once: true })
    })

    let id = 0
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    ws.addEventListener('message', (ev: any) => { const data = (ev as any).data;
      const msg = JSON.parse(data.toString())
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!.resolve(msg)
        pending.delete(msg.id)
      }
    })
    const send = <T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const mid = ++id
      return new Promise<T>((resolve, reject) => {
        pending.set(mid, { resolve: (m: any) => resolve(m.result), reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); reject(new Error(`CDP ${method} timeout`)) }
        }, 30000)
      })
    }

    await send('Page.enable')
    await send('Runtime.enable')
    try {
      await send('Runtime.removeBinding', { name: '__m365Emit' })
    } catch { /* not registered yet */ }
    try {
      await send('Runtime.addBinding', { name: '__m365Emit' })
    } catch { /* older protocols */ }
    try {
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch { /* older protocols */ }

    const bridge = new CopilotWebBridge(buildChatWsUrl(account), ws as unknown as WebSocket)
    // Wire CDP messaging onto the bridge before injecting the page script.
    ;(bridge as any)._sendCdp = send
    ws.addEventListener('message', (ev: any) => { const data = (ev as any).data;
      const msg = JSON.parse(data.toString())
      if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__m365Emit') {
        bridge.pushBinding(msg.params.payload)
      }
    })
    return bridge
  }

  private _bindingNext(): Promise<any> {
    if (this.bindingQueue.length) return Promise.resolve(this.bindingQueue.shift())
    return new Promise((resolve) => { this.bindingWaiter = resolve })
  }

  pushBinding(payload: string): void {
    let parsed: any
    try { parsed = JSON.parse(payload) } catch { parsed = { raw: payload } }
    if (this.bindingWaiter) {
      const w = this.bindingWaiter
      this.bindingWaiter = null
      w(parsed)
    } else {
      this.bindingQueue.push(parsed)
    }
  }

  async chat(
    account: ChatHubAccount,
    request: ChatRequest,
    onDelta?: StreamHandler,
    onEvent?: StreamHandler,
  ): Promise<ChatResult> {
    const send = (this as any)._sendCdp as <T>(method: string, params?: Record<string, unknown>) => Promise<T>

    // Fresh state per chat so concurrent requests never share a socket.
    await send('Runtime.evaluate', {
      expression: `(function(){ if (window.__m365ChatWs) { try { window.__m365ChatWs.close(); } catch(e){} window.__m365ChatWs=null; } return 1 })()`,
    })

    await send('Runtime.evaluate', {
      expression: ACQUIRE_AT_JS.replace('__FALLBACK_AT__', JSON.stringify(account.accessToken)),
      awaitPromise: true,
      returnByValue: true,
    })
    const conversationId = request.conversationId || (await this.createConversation(send))
    const events: StreamEvent[] = []
    let streamed = ''
    let reasoning = ''
    let throttling: unknown
    let settled = false

    const openResult = await send('Runtime.evaluate', {
      expression: OPEN_WS_SNIPPET
        .replace('__FALLBACK_AT__', JSON.stringify(account.accessToken))
        .replace('__CONVID__', JSON.stringify(conversationId))
        .replace('__TEXT__', JSON.stringify(request.text)),
      awaitPromise: false,
      returnByValue: true,
    })
    if (openResult && (openResult as any).exceptionDetails) {
      throw new Error('Failed to open in-page WebSocket: ' + JSON.stringify((openResult as any).exceptionDetails).slice(0, 200))
    }

    const finish = (err?: Error): ChatResult => {
      const result: ChatResult = {
        text: streamed,
        reasoning: reasoning || undefined,
        conversationId,
        sessionId: request.sessionId || conversationId,
        requestId: conversationId,
        throttling,
        rawResult: JSON.stringify(events),
        events,
      }
      void err
      return result
    }

    const fail = (message: string): never => {
      const error = new Error(message)
      ;(error as any).handled = true
      throw error
    }

    while (!settled) {
      const frame: BridgeFrame = await Promise.race([
        (this as any)._bindingNext(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('M365 Copilot bridge timeout')), 300000)),
      ])

      if (frame.kind === 'open') continue
      if (frame.kind === 'close') {
        if (!settled) fail(`In-page WebSocket closed early (${frame.code})`)
        break
      }

      let obj = frame.data as BridgeFrame
    if (typeof obj === 'string') { try { obj = JSON.parse(obj) as BridgeFrame } catch { continue } }
      if (!obj || typeof obj !== 'object') continue

      if (obj.event === 'connected') continue
      if (obj.event === 'ping') {
        await send('Runtime.evaluate', {
          expression: `window.__m365ChatWs && window.__m365ChatWs.readyState===1 && window.__m365ChatWs.send(JSON.stringify({event:'pong'}))`,
        })
        continue
      }
      if (obj.event === 'pong') continue
      if (obj.event === 'error') {
        if (obj.errorCode === 'invalid-event' || obj.errorCode === 'unauthorized') {
          fail(`Copilot rejected the request (${obj.errorCode}); refresh the account token.`)
        }
        fail(`Copilot stream error: ${obj.errorCode || 'unknown'}`)
      }
      if (obj.event === 'appendText' && typeof obj.text === 'string') {
        streamed += obj.text
        const delta: StreamEvent = { kind: 'text', text: obj.text }
        events.push(delta)
        if (onDelta) await onDelta(delta)
        continue
      }
      if (obj.event === 'replaceText' && typeof obj.text === 'string') {
        const delta: StreamEvent = { kind: 'text', text: obj.text.slice(streamed.length) }
        streamed = obj.text
        if (delta.text && onDelta) await onDelta(delta)
        continue
      }
      if (obj.event === 'done' || obj.event === 'partCompleted') {
        if (obj.event === 'partCompleted') continue
        settled = true
        await send('Runtime.evaluate', {
          expression: `(function(){ if(window.__m365ChatWs){try{window.__m365ChatWs.close()}catch(e){} window.__m365ChatWs=null;} return 1 })()`,
        })
        return finish()
      }
    }
    return finish()
  }

  /** Create a conversation through the page so cookies/TLS stay first-party. */
  private async createConversation(
    send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  ): Promise<string> {
    const r: any = await send('Runtime.evaluate', {
      expression: `(async function(){
        try {
          var __at = window.__m365AT || '';
          var __hdr = { 'Content-Type': 'application/json' };
          if (__at) __hdr['Authorization'] = 'Bearer ' + __at;
          const res = await fetch('${CONVERSATIONS_API}', {
            method: 'POST',
            credentials: 'include',
            headers: __hdr,
            body: JSON.stringify({ mode: 'smart' }),
          });
          if (!res.ok) return JSON.stringify({ error: 'HTTP ' + res.status });
          const j = await res.json();
          return JSON.stringify({ id: j.id });
        } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    let parsed: { id?: string; error?: string } = {}
    try { parsed = JSON.parse(r?.result?.value) } catch { /* fallthrough */ }
    if (!parsed.id) throw new Error('Could not create Copilot conversation: ' + (parsed.error || 'unknown'))
    return parsed.id
  }
}

function buildChatWsUrl(account: ChatHubAccount): string {
  const params = new URLSearchParams({
    'api-version': '2',
    accessToken: account.accessToken,
  })
  return `wss://copilot.microsoft.com/c/api/chat?${params.toString()}`
}

const OPEN_WS_SNIPPET = `
(function(){
  const __at = window.__m365AT || __FALLBACK_AT__;
const ws = new WebSocket('wss://copilot.microsoft.com/c/api/chat?api-version=2&accessToken=' + encodeURIComponent(__at));
  window.__m365ChatWs = ws;
  const emit = (kind, data) => { try { __m365Emit(JSON.stringify({ kind, ...data })); } catch(e){} };
const sendChat = () => { ws.send(JSON.stringify({ event: 'send', conversationId: __CONVID__, content: [{ type: 'text', text: __TEXT__ }], mode: 'smart', context: {} })); };
  ws.onopen = () => {
    emit('open');
    ws.send(JSON.stringify({
      event: 'setOptions',
      supportedFeatures: ['partial-generated-images','composer-prefill-conversation-action','composer-send-conversation-action-v2','side-by-side-comparison','session-duration-nudge','compose-email-html'],
      supportedCards: [],
      supportedUIComponents: {},
    }));
    ws.send(JSON.stringify({ event: 'reportLocalConsents', grantedConsents: [] }));
    ws.send(JSON.stringify({
      event: 'send',
      conversationId: __CONVID__,
      content: [{ type: 'text', text: __TEXT__ }],
      mode: 'smart',
      context: {},
    }));
  };
  ws.onmessage = async (ev) => {
    let obj;
    try { obj = JSON.parse(ev.data); } catch(e) {}
    if (obj && obj.event === 'challenge') {
      if (obj.method === 'copilot') {
        const a = Number(obj.parameter);
        const token = Math.round((Math.pow(a,3)/100 + a*25) % 22).toString();
        ws.send(JSON.stringify({ event: 'challengeResponse', token: token, method: 'copilot' }));
        sendChat();
        return;
      }
      if (obj.method === 'hashcash') {
        const parts = String(obj.parameter || '').split(':');
        const seed = parts[0];
        const difficulty = Number(parts[1]);
        if (seed && difficulty > 0) {
          const enc = new TextEncoder();
          const check = (bytes) => {
            const n = Math.floor(difficulty / 8);
            const o = difficulty % 8;
            for (let s = 0; s < n; s++) if (bytes[s] !== 0) return false;
            if (o > 0) {
              const mask = 255 << (8 - o);
              if ((bytes[n] & mask) !== 0) return false;
            }
            return true;
          };
          for (let nonce = 0; nonce < 10000000; nonce++) {
            const data = enc.encode(seed + nonce);
            const hash = await crypto.subtle.digest('SHA-256', data);
            if (check(new Uint8Array(hash))) {
              ws.send(JSON.stringify({ event: 'challengeResponse', token: nonce.toString(), method: 'hashcash' }));
              sendChat();
              break;
            }
            if (nonce % 50 === 0) await new Promise(r => setTimeout(r, 0));
          }
          return;
        }
      }
    }
    emit('message', { data: ev.data });
  };
  ws.onclose = (ev) => { emit('close', { code: ev.code }); if (window.__m365ChatWs === ws) window.__m365ChatWs = null; };
  ws.onerror = () => { emit('close', { code: 9999 }); };
  return true;
})()`

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CDP list HTTP ${res.status}`)
  return res.json() as Promise<T>
}