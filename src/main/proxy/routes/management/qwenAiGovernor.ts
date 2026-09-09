import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { storeManager } from '../../../store/store'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { loadBalancer } from '../../loadbalancer'
import { qwenAiRequestGovernor } from '../../qwenAiRequestGovernor'
import { qwenAiSessionRepairService } from '../../qwenAiSessionRepair'
import { refreshQwenAiRiskSession } from '../../adapters/qwen-risk-refresh'
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

  const accounts = storeManager.getAccounts(true)
    .filter(account => qwenAiProviderIds.includes(account.providerId))

  return { accounts, providers }
}

router.get('/status', async (ctx: Context) => {
  const { accounts, providers } = getQwenAiAccounts()
  const status = qwenAiRequestGovernor.getStatus(
    accounts,
    providers,
    loadBalancer.getAccountFailureSnapshot(),
  )
  const accountById = new Map(accounts.map(account => [account.id, account]))

  ctx.body = {
    success: true,
    data: {
      ...status,
      sessionRepair: qwenAiSessionRepairService.getRuntimeStatus(),
      accounts: status.accounts.map(accountStatus => {
        const account = accountById.get(accountStatus.accountId)
        if (!account) return accountStatus
        const repairStatus = qwenAiSessionRepairService.getAccountStatus(account)
        return {
          ...accountStatus,
          webSessionReady: repairStatus.ready,
          webSessionRepairable: repairStatus.repairable,
          webSessionRepairState: repairStatus.state,
          webSessionNextAttemptAt: repairStatus.nextAttemptAt,
        }
      }),
    },
  } as ManagementApiResponse<QwenAiGovernorStatus>
})

router.get('/config', async (ctx: Context) => {
  ctx.body = {
    success: true,
    data: qwenAiRequestGovernor.getConfiguredConfig(),
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

/**
 * Manual risk-session refresh (x5sec harvest): launches the browser-based
 * aliyun slider solver for one account and persists the harvested risk
 * cookies. Immediate remedy when an account is pinned behind RGV587
 * (FAIL_SYS_USER_VALIDATE) — rotation and exit-IP changes cannot escape
 * that verdict, only a re-validated session can.
 */
router.post('/accounts/:accountId/refresh-risk-session', async (ctx: Context) => {
  const accountId = ctx.params.accountId
  const account = storeManager.getAccounts(true).find(candidate => candidate.id === accountId)
  if (!account) {
    ctx.status = 404
    ctx.body = {
      success: false,
      error: { code: 'not_found', message: `Account not found: ${accountId}` },
    } as ManagementApiResponse
    return
  }
  const updated = await refreshQwenAiRiskSession(account)
  if (!updated) {
    ctx.status = 502
    ctx.body = {
      success: false,
      error: {
        code: 'refresh_failed',
        message: 'Risk-session refresh did not return usable cookies (see service logs)',
      },
    } as ManagementApiResponse
    return
  }
  ctx.body = {
    success: true,
    data: {
      accountId,
      refreshed: true,
      hasCookies: Boolean(updated.credentials.cookies || updated.credentials.cookie),
    },
  } as ManagementApiResponse<{ accountId: string; refreshed: boolean; hasCookies: boolean }>
})

export default router
