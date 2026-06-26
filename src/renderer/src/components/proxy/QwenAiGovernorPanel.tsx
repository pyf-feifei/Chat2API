import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import type { QwenAiGovernorConfig, QwenAiGovernorStatus } from '@/types/electron'
import { Gauge, RefreshCw, ShieldAlert, Snowflake, Trash2 } from 'lucide-react'

type FormState = {
  maxConcurrent: string
  globalMinIntervalSec: string
  accountMinIntervalSec: string
  riskCooldownMin: string
  maxRiskCooldownMin: string
  failureCooldownMin: string
}

function toFormState(config: QwenAiGovernorConfig): FormState {
  return {
    maxConcurrent: String(config.maxConcurrent),
    globalMinIntervalSec: String(Math.round(config.globalMinIntervalMs / 1000)),
    accountMinIntervalSec: String(Math.round(config.accountMinIntervalMs / 1000)),
    riskCooldownMin: String(Math.round(config.riskCooldownMs / 60000)),
    maxRiskCooldownMin: String(Math.round(config.maxRiskCooldownMs / 60000)),
    failureCooldownMin: String(Math.round(config.failureCooldownMs / 60000)),
  }
}

function toConfig(form: FormState): QwenAiGovernorConfig {
  return {
    maxConcurrent: Number.parseInt(form.maxConcurrent, 10),
    globalMinIntervalMs: Number.parseInt(form.globalMinIntervalSec, 10) * 1000,
    accountMinIntervalMs: Number.parseInt(form.accountMinIntervalSec, 10) * 1000,
    riskCooldownMs: Number.parseInt(form.riskCooldownMin, 10) * 60000,
    maxRiskCooldownMs: Number.parseInt(form.maxRiskCooldownMin, 10) * 60000,
    failureCooldownMs: Number.parseInt(form.failureCooldownMin, 10) * 60000,
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '-'
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const restMinutes = minutes % 60
    return `${hours}h ${restMinutes}m`
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function isPositiveInteger(value: string): boolean {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === value.trim()
}

export function QwenAiGovernorPanel() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [status, setStatus] = useState<QwenAiGovernorStatus | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const lastSyncedFormRef = useRef<string | null>(null)

  const hasChanges = useMemo(() => {
    if (!status || !form) return false
    return JSON.stringify(toFormState(status.config)) !== JSON.stringify(form)
  }, [form, status])

  const loadStatus = useCallback(async (options: { preserveDirty?: boolean } = {}) => {
    if (!window.electronAPI?.qwenAiGovernor?.getStatus) return
    setIsLoading(true)
    try {
      const nextStatus = await window.electronAPI.qwenAiGovernor.getStatus()
      setStatus(nextStatus)
      if (nextStatus) {
        const nextForm = toFormState(nextStatus.config)
        const nextFormKey = JSON.stringify(nextForm)
        setForm(prev => {
          const isDirty = prev !== null && JSON.stringify(prev) !== lastSyncedFormRef.current
          if (options.preserveDirty && isDirty) {
            return prev
          }
          lastSyncedFormRef.current = nextFormKey
          return nextForm
        })
      }
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('proxy.qwenGovernor.loadFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    loadStatus({ preserveDirty: true })
    const interval = window.setInterval(() => loadStatus({ preserveDirty: true }), 5000)
    return () => window.clearInterval(interval)
  }, [loadStatus])

  const updateField = (field: keyof FormState, value: string) => {
    if (!/^\d*$/.test(value)) return
    setForm(prev => prev ? { ...prev, [field]: value } : prev)
  }

  const validateForm = (): boolean => {
    if (!form) return false
    const fields = Object.values(form)
    if (fields.some(value => !isPositiveInteger(value))) return false
    const config = toConfig(form)
    return config.maxConcurrent >= 1 && config.maxRiskCooldownMs >= config.riskCooldownMs
  }

  const handleSave = async () => {
    if (!form || !validateForm()) {
      toast({
        title: t('proxy.validationFailed'),
        description: t('proxy.qwenGovernor.validationFailed'),
        variant: 'destructive',
      })
      return
    }

    setIsSaving(true)
    try {
      await window.electronAPI.qwenAiGovernor.updateConfig(toConfig(form))
      toast({
        title: t('common.success'),
        description: t('proxy.qwenGovernor.saved'),
      })
      await loadStatus()
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleClearAccount = async (accountId: string) => {
    await window.electronAPI.qwenAiGovernor.clearAccountCooldown(accountId)
    await loadStatus({ preserveDirty: true })
  }

  const handleClearAll = async () => {
    await window.electronAPI.qwenAiGovernor.clearAllCooldowns()
    await loadStatus({ preserveDirty: true })
  }

  const accounts = status?.accounts ?? []
  const cooledAccounts = accounts.filter(account =>
    account.governorCooldownInMs > 0 || account.loadBalancerCooldownInMs > 0,
  )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Gauge className="h-5 w-5 text-primary" />
              <CardTitle>{t('proxy.qwenGovernor.title')}</CardTitle>
            </div>
            <Button variant="ghost" size="icon" onClick={loadStatus} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <CardDescription>{t('proxy.qwenGovernor.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">{t('proxy.qwenGovernor.queueSize')}</p>
              <p className="mt-1 text-2xl font-semibold">{status?.queueSize ?? 0}</p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">{t('proxy.qwenGovernor.activeRequests')}</p>
              <p className="mt-1 text-2xl font-semibold">{status?.activeRequests ?? 0}</p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">{t('proxy.qwenGovernor.globalWait')}</p>
              <p className="mt-1 text-2xl font-semibold">{formatDuration(status?.globalNextAvailableInMs ?? 0)}</p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-sm text-muted-foreground">{t('proxy.qwenGovernor.cooldownAccounts')}</p>
              <p className="mt-1 text-2xl font-semibold">{cooledAccounts.length}</p>
            </div>
          </div>

          {form && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="qwen-max-concurrent">{t('proxy.qwenGovernor.maxConcurrent')}</Label>
                  <Input
                    id="qwen-max-concurrent"
                    value={form.maxConcurrent}
                    onChange={(event) => updateField('maxConcurrent', event.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qwen-global-interval">{t('proxy.qwenGovernor.globalMinInterval')}</Label>
                  <Input
                    id="qwen-global-interval"
                    value={form.globalMinIntervalSec}
                    onChange={(event) => updateField('globalMinIntervalSec', event.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qwen-account-interval">{t('proxy.qwenGovernor.accountMinInterval')}</Label>
                  <Input
                    id="qwen-account-interval"
                    value={form.accountMinIntervalSec}
                    onChange={(event) => updateField('accountMinIntervalSec', event.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qwen-risk-cooldown">{t('proxy.qwenGovernor.riskCooldown')}</Label>
                  <Input
                    id="qwen-risk-cooldown"
                    value={form.riskCooldownMin}
                    onChange={(event) => updateField('riskCooldownMin', event.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qwen-max-risk-cooldown">{t('proxy.qwenGovernor.maxRiskCooldown')}</Label>
                  <Input
                    id="qwen-max-risk-cooldown"
                    value={form.maxRiskCooldownMin}
                    onChange={(event) => updateField('maxRiskCooldownMin', event.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qwen-failure-cooldown">{t('proxy.qwenGovernor.failureCooldown')}</Label>
                  <Input
                    id="qwen-failure-cooldown"
                    value={form.failureCooldownMin}
                    onChange={(event) => updateField('failureCooldownMin', event.target.value)}
                    inputMode="numeric"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => status && setForm(toFormState(status.config))}
                  disabled={!hasChanges || isSaving}
                >
                  {t('common.reset')}
                </Button>
                <Button onClick={handleSave} disabled={!hasChanges || isSaving || !validateForm()}>
                  {isSaving ? t('proxy.saving') : t('proxy.saveConfig')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-primary" />
              <CardTitle>{t('proxy.qwenGovernor.accountStatus')}</CardTitle>
            </div>
            <Button variant="outline" size="sm" onClick={handleClearAll} disabled={accounts.length === 0}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('proxy.qwenGovernor.clearAllCooldowns')}
            </Button>
          </div>
          <CardDescription>{t('proxy.qwenGovernor.accountStatusDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('providers.accountName')}</TableHead>
                <TableHead>{t('providers.status')}</TableHead>
                <TableHead>{t('proxy.qwenGovernor.queue')}</TableHead>
                <TableHead>{t('proxy.qwenGovernor.nextAvailable')}</TableHead>
                <TableHead>{t('proxy.qwenGovernor.reason')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {t('proxy.qwenGovernor.noAccounts')}
                  </TableCell>
                </TableRow>
              ) : accounts.map(account => {
                const isCooling =
                  account.governorCooldownInMs > 0 ||
                  account.loadBalancerCooldownInMs > 0 ||
                  account.nextAvailableInMs > 0
                const reason = account.governorCooldownReason || account.loadBalancerReason || '-'

                return (
                  <TableRow key={account.accountId}>
                    <TableCell>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{account.accountName}</p>
                        <p className="truncate text-xs text-muted-foreground">{account.providerName}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.status === 'active' ? 'default' : 'secondary'}>
                        {account.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{account.queuedRequests}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {t('proxy.qwenGovernor.activeShort')}: {account.activeRequests}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {isCooling && <Snowflake className="h-4 w-4 text-blue-500" />}
                        <span>{formatDuration(account.nextAvailableInMs)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{reason}</code>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleClearAccount(account.accountId)}
                        disabled={!isCooling}
                      >
                        {t('proxy.qwenGovernor.clearCooldown')}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

export default QwenAiGovernorPanel
