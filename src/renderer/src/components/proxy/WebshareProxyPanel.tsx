import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import type { WebshareProxyConfigPayload, WebshareProxyListItem } from '@/types/electron'
import { ChevronDown, ChevronRight, Globe, Loader2, Plus, RefreshCw, Save, ShieldAlert, Snowflake, Trash2, Undo2 } from 'lucide-react'

type FormApiKey = {
  id: string
  label: string
  apiKey: string
  isNew: boolean
}

type FormState = {
  enabled: boolean
  proxyUrl: string
  apiKeys: FormApiKey[]
  rotationStrategy: 'round-robin' | 'random' | 'failover'
  autoSync: boolean
  syncIntervalMinutes: number
}

function toFormState(payload: WebshareProxyConfigPayload): FormState {
  return {
    enabled: payload.enabled,
    proxyUrl: payload.proxyUrl ?? '',
    apiKeys: (payload.apiKeys ?? []).map(key => ({
      id: key.id,
      label: key.label,
      apiKey: key.apiKey,
      isNew: false,
    })),
    rotationStrategy: payload.rotationStrategy ?? 'round-robin',
    autoSync: payload.autoSync ?? true,
    syncIntervalMinutes: payload.syncIntervalMinutes ?? 30,
  }
}

function entryUrlOf(item: WebshareProxyListItem): string {
  return `http://${item.username}:${item.password}@${item.ipAddress}:${item.port}`
}

function formatCooldown(until?: number): string | undefined {
  if (!until || until <= Date.now()) return undefined
  const seconds = Math.ceil((until - Date.now()) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function WebshareProxyPanel() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [payload, setPayload] = useState<WebshareProxyConfigPayload | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null)
  const [keyLists, setKeyLists] = useState<Record<string, { loading: boolean; items: WebshareProxyListItem[]; error?: string }>>({})
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [dialogLabel, setDialogLabel] = useState('')
  const [dialogKey, setDialogKey] = useState('')
  const lastSyncedFormRef = useRef<string | null>(null)

  const hasChanges = useMemo(() => {
    if (!payload || !form) return false
    return JSON.stringify(toFormState(payload)) !== JSON.stringify(form)
  }, [form, payload])

  /** Map proxy URL -> runtime entry state (cooldown, failures) from the synced pool. */
  const poolStateByUrl = useMemo(
    () => new Map((payload?.entries ?? []).map(entry => [entry.proxyUrl, entry])),
    [payload],
  )

  const loadConfig = useCallback(async (options: { preserveDirty?: boolean } = {}) => {
    if (!window.electronAPI?.webshareProxy?.getConfig) return
    setIsLoading(true)
    try {
      const next = await window.electronAPI.webshareProxy.getConfig()
      if (!next) return
      setPayload(next)
      const nextForm = toFormState(next)
      if (!options.preserveDirty || lastSyncedFormRef.current === JSON.stringify(form)) {
        setForm(nextForm)
        lastSyncedFormRef.current = JSON.stringify(nextForm)
      }
    } catch (error) {
      toast({
        title: t('proxy.webshare.loadFailed', 'Failed to load Webshare proxy config'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [form, t, toast])

  useEffect(() => {
    loadConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const validateProxyUrl = (value: string): boolean => {
    try {
      const parsed = new URL(value)
      return /^https?:$/.test(parsed.protocol)
    } catch {
      return false
    }
  }

  const handleSave = async () => {
    if (!form || !payload) return

    for (const key of form.apiKeys) {
      if (key.isNew && !key.apiKey.trim()) {
        toast({
          title: t('proxy.webshare.apiKeys.keyRequired', 'API key is required'),
          description: t('proxy.webshare.apiKeys.keyRequiredDesc', 'Paste the Webshare API key token or remove the row.'),
          variant: 'destructive',
        })
        return
      }
    }

    const singleUrl = form.proxyUrl.trim()
    const hasKeys = form.apiKeys.length > 0

    if (form.enabled && !hasKeys && !singleUrl) {
      toast({
        title: t('proxy.webshare.urlRequired', 'Proxy URL is required'),
        description: t('proxy.webshare.urlRequiredDesc', 'Add at least one API key or enter a proxy URL before enabling.'),
        variant: 'destructive',
      })
      return
    }

    if (singleUrl && !validateProxyUrl(singleUrl)) {
      toast({
        title: t('proxy.webshare.invalidUrl', 'Invalid proxy URL'),
        description: t('proxy.webshare.invalidUrlDesc', 'Expected format: http://user:pass@proxy.webshare.io:8080'),
        variant: 'destructive',
      })
      return
    }

    setIsSaving(true)
    try {
      const apiKeys = form.apiKeys.map(key => ({
        id: key.id,
        label: key.label,
        ...(key.apiKey.trim() ? { apiKey: key.apiKey.trim() } : {}),
      }))

      const next = await window.electronAPI!.webshareProxy.updateConfig({
        enabled: form.enabled,
        ...(singleUrl ? { proxyUrl: singleUrl } : {}),
        ...(hasKeys ? { rotationStrategy: form.rotationStrategy } : {}),
        apiKeys,
        autoSync: form.autoSync,
        syncIntervalMinutes: form.syncIntervalMinutes,
      })

      setPayload(next)
      const nextForm = toFormState(next)
      setForm(nextForm)
      lastSyncedFormRef.current = JSON.stringify(nextForm)

      toast({
        title: t('proxy.webshare.saved', 'Webshare proxy config saved'),
        description: next.effective.enabled
          ? t('proxy.webshare.enabledEffective', 'RGV587 recovery will retry through the Webshare proxy.')
          : t('proxy.webshare.disabledEffective', 'The Webshare recovery proxy is disabled.'),
      })
    } catch (error) {
      toast({
        title: t('proxy.webshare.saveFailed', 'Failed to save Webshare proxy config'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleSyncNow = async () => {
    setIsSaving(true)
    try {
      const next = await window.electronAPI!.webshareProxy.syncNow()
      setPayload(next)
      const nextForm = toFormState(next)
      setForm(nextForm)
      lastSyncedFormRef.current = JSON.stringify(nextForm)

      toast({
        title: t('proxy.webshare.sync.done', 'Pool synced'),
        description: next.sync?.lastError || t('proxy.webshare.sync.doneDesc', "Pool entries now match each key's Proxy List."),
      })
    } catch (error) {
      toast({
        title: t('proxy.webshare.sync.failed', 'Sync failed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleClear = async () => {
    setIsSaving(true)
    try {
      const next = await window.electronAPI!.webshareProxy.clearConfig()
      setPayload(next)
      const nextForm: FormState = { enabled: false, proxyUrl: '', apiKeys: [], rotationStrategy: 'round-robin', autoSync: true, syncIntervalMinutes: 30 }
      setForm(nextForm)
      lastSyncedFormRef.current = JSON.stringify(nextForm)

      toast({
        title: t('proxy.webshare.cleared', 'Webshare proxy config cleared'),
        description: t('proxy.webshare.clearedDesc', 'The section now follows environment variables only.'),
      })
    } catch (error) {
      toast({
        title: t('proxy.webshare.clearFailed', 'Failed to clear Webshare proxy config'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDisengageSticky = async () => {
    setIsSaving(true)
    try {
      const next = await window.electronAPI!.webshareProxy.disengageSticky()
      setPayload(next)
      toast({
        title: t('proxy.webshare.sticky.disengaged', 'Sticky mode disengaged'),
        description: t(
          'proxy.webshare.sticky.disengagedDesc',
          'Qwen traffic is back on the direct exit; the per-request recovery path remains.',
        ),
      })
    } catch (error) {
      toast({
        title: t('proxy.webshare.sticky.disengageFailed', 'Failed to disengage sticky mode'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const openAddKeyDialog = () => {
    setDialogLabel('')
    setDialogKey('')
    setAddDialogOpen(true)
  }

  const confirmAddKey = () => {
    const apiKey = dialogKey.trim()
    if (!apiKey) {
      toast({
        title: t('proxy.webshare.apiKeys.keyRequired', 'API key is required'),
        description: t('proxy.webshare.apiKeys.keyRequiredDesc', 'Paste the Webshare API key token.'),
        variant: 'destructive',
      })
      return
    }
    setForm(prev => prev ? {
      ...prev,
      apiKeys: [
        ...prev.apiKeys,
        { id: `new-${Date.now()}`, label: dialogLabel.trim(), apiKey, isNew: true },
      ],
    } : prev)
    setAddDialogOpen(false)
  }

  const removeApiKey = (id: string) => {
    setForm(prev => prev ? { ...prev, apiKeys: prev.apiKeys.filter(key => key.id !== id) } : prev)
    setExpandedKeyId(prev => (prev === id ? null : prev))
  }

  const toggleKeyExpand = (id: string) => {
    const next = expandedKeyId === id ? null : id
    setExpandedKeyId(next)
    if (next) {
      const key = form?.apiKeys.find(candidate => candidate.id === id)
      if (key && !keyLists[id]) {
        void fetchKeyList(id, key.apiKey, false)
      }
    }
  }

  const fetchKeyList = async (id: string, apiKey: string, force: boolean) => {
    const trimmed = apiKey.trim()
    if (!trimmed) return
    if (!force && keyLists[id]) return
    setKeyLists(prev => ({ ...prev, [id]: { loading: true, items: prev[id]?.items ?? [] } }))
    try {
      const result = await window.electronAPI!.webshareProxy.fetchProxyList(trimmed)
      setKeyLists(prev => ({ ...prev, [id]: { loading: false, items: result.items } }))
    } catch (error) {
      setKeyLists(prev => ({
        ...prev,
        [id]: { loading: false, error: error instanceof Error ? error.message : String(error), items: prev[id]?.items ?? [] },
      }))
    }
  }

  if (isLoading && !payload) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            {t('proxy.webshare.title', 'Webshare Proxy (RGV587 Recovery)')}
          </CardTitle>
          <CardDescription>
            {t(
              'proxy.webshare.description',
              'RGV587 is IP-level risk control: rotating accounts cannot bypass it because all accounts share the same exit IP. When enabled, only the recovery retry path goes through this proxy.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* --- Status badges --- */}
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={payload?.effective.enabled ? 'default' : 'secondary'}>
              {payload?.effective.enabled
                ? t('proxy.webshare.active', 'Active')
                : t('proxy.webshare.inactive', 'Inactive')}
            </Badge>
            {payload?.source === 'env' && (
              <Badge variant="outline">
                {t('proxy.webshare.envSource', 'Env fallback')}
              </Badge>
            )}
            {payload?.effective.proxyUrl && (
              <code className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {payload.effective.proxyUrl}
              </code>
            )}
          </div>

          {/* --- Sticky mode banner --- */}
          {payload?.sticky?.active && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                  <ShieldAlert className="h-4 w-4" />
                  {t('proxy.webshare.sticky.title', 'Sticky mode: all Qwen traffic is on the Webshare proxy')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {payload.sticky.reason
                    ? `${t('proxy.webshare.sticky.reason', 'Reason')}: ${payload.sticky.reason}`
                    : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'proxy.webshare.sticky.desc',
                    'Since {{since}} · direct-IP probe passed {{passed}}/2 clean checks · next probe {{next}}',
                    {
                      since: new Date(payload.sticky.since).toLocaleString(),
                      passed: payload.sticky.passedProbes,
                      next: payload.sticky.nextProbeAt > Date.now()
                        ? new Date(payload.sticky.nextProbeAt).toLocaleTimeString()
                        : t('proxy.webshare.sticky.dueNow', 'due now'),
                    },
                  )}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleDisengageSticky} disabled={isSaving}>
                <Undo2 className="h-4 w-4" />
                {t('proxy.webshare.sticky.manual', 'Back to direct now')}
              </Button>
            </div>
          )}

          {/* --- Webshare API Keys --- */}
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Label>{t('proxy.webshare.apiKeys.title', 'Webshare API Keys')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'proxy.webshare.apiKeys.desc',
                    'Add API keys from Webshare dashboard API > Keys. All IPs under each key are automatically included in the rotation pool.',
                  )}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={openAddKeyDialog}>
                <Plus className="h-4 w-4" />
                {t('proxy.webshare.apiKeys.add', 'Add API Key')}
              </Button>
            </div>

            {/* --- Auto-sync controls --- */}
            <div className="flex flex-wrap items-center gap-3 rounded-md border p-2">
              <div className="flex items-center gap-2">
                <Switch
                  checked={form?.autoSync ?? true}
                  onCheckedChange={checked => setForm(prev => prev ? { ...prev, autoSync: checked } : prev)}
                />
                <Label className="text-xs">{t('proxy.webshare.sync.autoSync', 'Auto sync pool')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs">{t('proxy.webshare.sync.interval', 'Interval (min)')}</Label>
                <Input
                  className="h-8 w-24"
                  type="number"
                  min={5}
                  max={1440}
                  value={String(form?.syncIntervalMinutes ?? 30)}
                  onChange={event => setForm(prev => prev ? { ...prev, syncIntervalMinutes: Number(event.target.value) || 30 } : prev)}
                />
              </div>
              <Button variant="outline" size="sm" onClick={handleSyncNow} disabled={isSaving || Boolean(payload?.sync?.syncing)}>
                <RefreshCw className={'h-4 w-4' + (payload?.sync?.syncing ? ' animate-spin' : '')} />
                {t('proxy.webshare.sync.now', 'Sync now')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {payload?.sync?.lastSyncAt
                  ? t('proxy.webshare.sync.last', 'Last sync {{time}}', { time: new Date(payload.sync.lastSyncAt).toLocaleString() })
                  : t('proxy.webshare.sync.never', 'Not synced yet')}
                {payload?.sync?.lastError ? ' · ' + payload.sync.lastError : ''}
              </span>
            </div>

            {/* --- Rotation strategy --- */}
            {form && form.apiKeys.length > 0 && (
              <div className="flex items-center gap-2">
                <Label htmlFor="webshare-rotation" className="text-xs">
                  {t('proxy.webshare.pool.rotation', 'Rotation')}
                </Label>
                <Select
                  value={form.rotationStrategy}
                  onValueChange={value => setForm(prev => prev
                    ? { ...prev, rotationStrategy: value as FormState['rotationStrategy'] }
                    : prev)}
                >
                  <SelectTrigger id="webshare-rotation" className="h-8 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="round-robin">
                      {t('proxy.webshare.pool.roundRobin', 'Round-robin')}
                    </SelectItem>
                    <SelectItem value="failover">
                      {t('proxy.webshare.pool.failover', 'Failover (sticky primary)')}
                    </SelectItem>
                    <SelectItem value="random">
                      {t('proxy.webshare.pool.random', 'Random')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* --- Key list with expandable proxy lists --- */}
            {form?.apiKeys && form.apiKeys.length > 0 && (
              <div className="space-y-2">
                {form.apiKeys.map(key => {
                  const expanded = expandedKeyId === key.id
                  const list = keyLists[key.id]
                  return (
                    <div key={key.id} className="space-y-2 rounded-md border p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => toggleKeyExpand(key.id)}
                        >
                          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </Button>
                        <span className="w-36 truncate text-sm font-medium">
                          {key.label || t('proxy.webshare.apiKeys.unnamed', 'Untitled')}
                        </span>
                        <span className="min-w-48 flex-1 truncate font-mono text-xs text-muted-foreground">{key.apiKey}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleKeyExpand(key.id)}
                        >
                          {expanded
                            ? t('proxy.webshare.apiKeys.collapse', 'Collapse')
                            : t('proxy.webshare.apiKeys.expand', 'Proxy List')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => removeApiKey(key.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      {expanded && (
                        <div className="space-y-2 rounded-md bg-muted/40 p-2">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => fetchKeyList(key.id, key.apiKey, true)}
                              disabled={list?.loading}
                            >
                              <RefreshCw className={'h-4 w-4' + (list?.loading ? ' animate-spin' : '')} />
                              {list && list.items.length > 0
                                ? t('proxy.webshare.apiKeys.refresh', 'Refresh list')
                                : t('proxy.webshare.apiKeys.fetch', 'Fetch Proxy List')}
                            </Button>
                          </div>

                          {list?.loading && (
                            <p className="text-xs text-muted-foreground">
                              {t('proxy.webshare.apiKeys.loading', 'Loading proxy list...')}
                            </p>
                          )}

                          {list?.error && (
                            <p className="text-xs text-destructive">
                              {t('proxy.webshare.apiKeys.error', 'Failed to fetch proxy list')}: {list.error}
                            </p>
                          )}

                          {list && !list.loading && !list.error && list.items.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              {t('proxy.webshare.apiKeys.empty', 'No proxies under this key.')}
                            </p>
                          )}

                          {list && list.items.length > 0 && (
                            <div className="space-y-1">
                              {list.items.map((item, index) => {
                                const runtimeState = poolStateByUrl.get(entryUrlOf(item))
                                const cooling = formatCooldown(runtimeState?.cooldownUntil)
                                const failures = runtimeState?.failureCount ?? 0
                                return (
                                  <div
                                    key={`${item.ipAddress}:${item.port}:${index}`}
                                    className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-1.5 text-xs"
                                  >
                                    <span className="font-mono">{item.ipAddress}:{item.port}</span>
                                    <span className="font-mono text-muted-foreground">{item.username}:{item.password}</span>
                                    <span className="text-muted-foreground">{item.countryName || item.country || '-'}</span>
                                    {cooling && (
                                      <Badge variant="outline" className="gap-1">
                                        <Snowflake className="h-3 w-3" />
                                        {t('proxy.webshare.pool.cooling', 'cooling {{time}}', { time: cooling })}
                                      </Badge>
                                    )}
                                    {failures > 0 && (
                                      <Badge variant="destructive">
                                        {t('proxy.webshare.pool.failures', '{{count}} fails', { count: failures })}
                                      </Badge>
                                    )}
                                    {runtimeState?.enabled === false && (
                                      <Badge variant="secondary">disabled</Badge>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* --- Single URL fallback --- */}
          <div className="space-y-2">
            <Label htmlFor="webshare-proxy-url">
              {t('proxy.webshare.proxyUrl', 'Single proxy URL (fallback when no API keys)')}
            </Label>
            <Input
              id="webshare-proxy-url"
              placeholder="http://user:pass@proxy.webshare.io:8080"
              value={form?.proxyUrl ?? ''}
              onChange={event => setForm(prev => prev ? { ...prev, proxyUrl: event.target.value } : prev)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'proxy.webshare.proxyUrlHint',
                'Full Webshare proxy URL with credentials. The password is redacted in logs and status displays.',
              )}
            </p>
          </div>

          {/* --- Enable switch --- */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="webshare-proxy-enabled">
                {t('proxy.webshare.enable', 'Enable recovery proxy')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'proxy.webshare.enableHint',
                  'Applies immediately without restart. RGV587-busy and document-pipeline failures retry once through the proxy.',
                )}
              </p>
            </div>
            <Switch
              id="webshare-proxy-enabled"
              checked={form?.enabled ?? false}
              onCheckedChange={checked => setForm(prev => prev ? { ...prev, enabled: checked } : prev)}
            />
          </div>

          {/* --- Action buttons --- */}
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={!hasChanges || isSaving || !form}>
              {isSaving
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Save className="h-4 w-4" />}
              {t('common.save', 'Save')}
            </Button>
            <Button
              variant="outline"
              onClick={() => loadConfig()}
              disabled={isLoading || isSaving}
            >
              <RefreshCw className="h-4 w-4" />
              {t('common.refresh', 'Refresh')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleClear}
              disabled={isSaving || payload?.source !== 'config'}
            >
              <Trash2 className="h-4 w-4" />
              {t('proxy.webshare.clear', 'Clear (back to env)')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* --- Add API Key dialog --- */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('proxy.webshare.apiKeys.dialogTitle', 'Add Webshare API Key')}</DialogTitle>
            <DialogDescription>
              {t('proxy.webshare.apiKeys.dialogDesc', 'Paste an API key token created under Webshare dashboard API > Keys.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="webshare-api-key-label">
                {t('proxy.webshare.apiKeys.labelPlaceholder', 'Label (optional)')}
              </Label>
              <Input
                id="webshare-api-key-label"
                value={dialogLabel}
                onChange={event => setDialogLabel(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webshare-api-key-value">
                {t('proxy.webshare.apiKeys.keyPlaceholder', 'Webshare API key (Token)')}
              </Label>
              <Input
                id="webshare-api-key-value"
                value={dialogKey}
                onChange={event => setDialogKey(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              {t('proxy.webshare.apiKeys.cancel', 'Cancel')}
            </Button>
            <Button onClick={confirmAddKey}>
              {t('proxy.webshare.apiKeys.confirm', 'Add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default WebshareProxyPanel