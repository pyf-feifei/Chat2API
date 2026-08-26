import type { BuiltinProviderConfig } from '../../store/types'

export const m365CopilotConfig: BuiltinProviderConfig = {
  "id": "m365-copilot",
  "name": "Microsoft 365 Copilot",
  "type": "builtin",
  "authType": "oauth",
  "apiEndpoint": "https://substrate.office.com/m365Copilot/Chathub",
  "chatPath": "",
  "headers": {
    "Origin": "https://m365.cloud.microsoft",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0"
  },
  "enabled": true,
  "description": "Microsoft 365 Copilot via ChatHub WebSocket protocol",
  "supportedModels": [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ],
  "modelMappings": {
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-5.6-luna": "gpt-5.6-luna"
  },
  "credentialFields": [
    {
      "name": "accessToken",
      "label": "Access Token",
      "type": "password",
      "required": true,
      "placeholder": "Microsoft 365 access token",
      "helpText": "OAuth access token for Microsoft 365 Copilot"
    },
    {
      "name": "refreshToken",
      "label": "Refresh Token",
      "type": "password",
      "required": true,
      "placeholder": "Microsoft 365 refresh token",
      "helpText": "OAuth refresh token for automatic token renewal"
    },
    {
      "name": "oid",
      "label": "Object ID",
      "type": "text",
      "required": true,
      "placeholder": "User object ID (OID)",
      "helpText": "Microsoft account object ID from JWT token"
    },
    {
      "name": "tid",
      "label": "Tenant ID",
      "type": "text",
      "required": true,
      "placeholder": "Tenant ID (TID)",
      "helpText": "Microsoft tenant ID from JWT token"
    }
  ]
}

export default m365CopilotConfig
