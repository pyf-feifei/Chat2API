import type { BuiltinProviderConfig } from '../../store/types'

export const qwenAiConfig: BuiltinProviderConfig = {
  id: 'qwen-ai',
  name: 'Qwen AI (International)',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  chatPath: '/api/v2/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    source: 'web',
  },
  enabled: true,
  description: 'Qwen AI international version (chat.qwen.ai)',
  modelsApiEndpoint: 'https://chat.qwen.ai/api/v2/models/',
  modelsApiHeaders: {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://chat.qwen.ai/',
    source: 'web',
    Version: '0.2.35',
  },
  supportedModels: [
    'Qwen3.7-Plus',
    'Qwen3.7-Max',
    'Qwen3.6-Plus',
  ],
  modelMappings: {
    'Qwen3.7-Plus': 'qwen3.7-plus',
    'Qwen3.7-Max': 'qwen3.7-max',
    'Qwen3.6-Plus': 'qwen3.6-plus',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Auth Token',
      type: 'password',
      required: true,
      placeholder: 'Enter JWT token from chat.qwen.ai',
      helpText: 'JWT token obtained from chat.qwen.ai Local Storage (key: "token")',
    },
    {
      name: 'cookies',
      label: 'Cookies (Optional)',
      type: 'textarea',
      required: false,
      placeholder: 'Optional cookies for enhanced compatibility',
      helpText: 'Full cookie string from browser DevTools (optional but recommended)',
    },
    {
      name: 'email',
      label: 'Login Email (Optional)',
      type: 'text',
      required: false,
      placeholder: 'Optional account email for automatic token refresh',
      helpText: 'Used with password to refresh the chat.qwen.ai web token before it expires',
    },
    {
      name: 'password',
      label: 'Login Password (Optional)',
      type: 'password',
      required: false,
      placeholder: 'Optional account password for automatic token refresh',
      helpText: 'Stored in encrypted credentials when encryption is available; automatic refresh can fail if Qwen requires captcha, MFA, or risk verification',
    },
  ],
}

export default qwenAiConfig
