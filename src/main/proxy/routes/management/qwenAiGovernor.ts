import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { storeManager } from '../../../store/store'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { loadBalancer } from '../../loadbalancer'
import { qwenAiRequestGovernor } from '../../qwenAiRequestGovernor'
import type {
  ManagementApiResponse,
  QwenAiGovernorConfig,
  QwenAiGovernorStatus,
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/qwen-ai-governor' })

router.use(managementAuthMiddleware)

function getQwenAiAccounts() {
  const providers = storeManager.getProviders()
  const qwenAiProviderIds = providers
    .filter(provider => provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai'))
    .map(provider => provider.id)

  const accounts = storeManager.getAccounts()
    .filter(account => qwenAiProviderIds.includes(account.providerId))

  return { accounts, providers }
}

router.get('/status', async (ctx: Context) => {
  const { accounts, providers } = getQwenAiAccounts()

  ctx.body = {
    success: true,
    data: qwenAiRequestGovernor.getStatus(
      accounts,
      providers,
      loadBalancer.getAccountFailureSnapshot(),
    ),
  } as ManagementApiResponse<QwenAiGovernorStatus>
})

router.get('/config', async (ctx: Context) => {
  ctx.body = {
    success: true,
    data: ConfigManager.get().qwenAiGovernorConfig,
  } as ManagementApiResponse<QwenAiGovernorConfig>
})

router.put('/config', async (ctx: Context) => {
  const updates = ctx.request.body as Partial<QwenAiGovernorConfig>
  const validation = ConfigManager.validate({ qwenAiGovernorConfig: updates })

  if (!validation.valid) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: {
        code: 'validation_error',
        message: validation.errors.join('; '),
        details: { errors: validation.errors },
      },
    } as ManagementApiResponse
    return
  }

  const updated = ConfigManager.update({ qwenAiGovernorConfig: updates }).qwenAiGovernorConfig

  ctx.body = {
    success: true,
    data: updated,
  } as ManagementApiResponse<QwenAiGovernorConfig>
})

router.delete('/accounts/:accountId/cooldown', async (ctx: Context) => {
  const accountId = ctx.params.accountId
  qwenAiRequestGovernor.clearAccountCooldown(accountId)
  loadBalancer.clearAccountFailure(accountId)

  ctx.body = {
    success: true,
    data: { accountId },
  } as ManagementApiResponse<{ accountId: string }>
})

router.delete('/cooldowns', async (ctx: Context) => {
  qwenAiRequestGovernor.clearAllCooldowns()
  loadBalancer.clearAllAccountFailures()

  ctx.body = {
    success: true,
    data: { cleared: true },
  } as ManagementApiResponse<{ cleared: boolean }>
})

export default router
