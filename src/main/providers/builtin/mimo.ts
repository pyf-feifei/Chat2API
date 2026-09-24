import type { BuiltinProviderConfig } from '../../store/types'

export const mimoConfig: BuiltinProviderConfig = {
  id: 'mimo',
  name: 'Mimo',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://aistudio.xiaomimimo.com',
  chatPath: '/open-apis/bot/chat',
  headers: {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Origin': 'https://aistudio.xiaomimimo.com',
    'Referer': 'https://aistudio.xiaomimimo.com/',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Timezone': 'Asia/Shanghai',
  },
  enabled: true,
  description: 'XiaomiMIMO - Xiaomi General Intelligence Foundation Model',
  modelsApiEndpoint: 'https://aistudio.xiaomimimo.com/open-apis/bot/config',
  modelsApiHeaders: {
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://aistudio.xiaomimimo.com/',
    'Origin': 'https://aistudio.xiaomimimo.com',
  },
  supportedModels: [
    'MiMo-V2.6-Pro',
    'MiMo-V2.6-Flash',
    'MiMo-V2.5-Pro',
    'MiMo-V2.5',
    'MiMo-V2-Flash',
  ],
  modelMappings: {
    'MiMo-V2.6-Pro': 'mimo-v2.6-pro',
    'MiMo-V2.6-Flash': 'mimo-v2.6-flash',
    'MiMo-V2.5-Pro': 'mimo-v2.5-pro',
    'MiMo-V2.5': 'mimo-v2.5',
    'MiMo-V2-Flash': 'mimo-v2-flash',
  },
  credentialFields: [
    {
      name: 'service_token',
      label: 'Service Token',
      type: 'password',
      required: true,
      placeholder: 'Enter serviceToken from Cookie',
      helpText:
        'DevTools -> Application -> Cookies -> serviceToken. Expires ~24h; log out/in at aistudio.xiaomimimo.com to renew.',
    },
    {
      name: 'user_id',
      label: 'User ID',
      type: 'text',
      required: true,
      placeholder: 'Enter userId from Cookie',
      helpText: 'Found in browser DevTools -> Application -> Cookies -> userId',
    },
    {
      name: 'ph_token',
      label: 'PH Token',
      type: 'password',
      required: true,
      placeholder: 'Enter xiaomichatbot_ph from Cookie',
      helpText:
        'DevTools -> Application -> Cookies -> xiaomichatbot_ph. Re-import with serviceToken when the account is rejected.',
    },
  ],
}

export default mimoConfig
