import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Eye, EyeOff, Loader2, Mail, CheckCircle2, XCircle } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import type { GmailConfig, GmailTestResult } from '@/types/electron'

const DEFAULT_FORM: GmailConfig = {
  enabled: false,
  matonApiKey: '',
  matonConnectionId: '',
  gatewayBaseUrl: 'https://gateway.maton.ai/google-mail',
  controlBaseUrl: 'https://ctrl.maton.ai',
}

export function GmailSettings() {
  const { t } = useTranslation()
  const { config, updateConfig, fetchConfig } = useSettingsStore()

  const [form, setForm] = useState<GmailConfig>({ ...DEFAULT_FORM })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GmailTestResult | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; key: string } | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const stored = config?.gmailConfig
    if (!stored) return
    setForm((prev) => (dirty ? prev : { ...DEFAULT_FORM, ...stored }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.gmailConfig])

  useEffect(() => {
    if (!config) {
      void fetchConfig()
    }
  }, [config, fetchConfig])

  const patch = (updates: Partial<GmailConfig>) => {
    setDirty(true)
    setSaveMessage(null)
    setTestResult(null)
    setForm((prev) => ({ ...prev, ...updates }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMessage(null)
    try {
      await updateConfig({ gmailConfig: { ...form } })
      setDirty(false)
      setSaveMessage({ ok: true, key: 'settings.gmail.saveSuccess' })
    } catch {
      setSaveMessage({ ok: false, key: 'settings.gmail.saveError' })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.config.testGmail({
        ...form,
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({
        ok: false,
        message: 'networkError',
        reply: String(error),
      })
    } finally {
      setTesting(false)
    }
  }

  const canTest = Boolean(form.matonApiKey.trim())

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {t('settings.gmail.title')}
          </CardTitle>
          <CardDescription>{t('settings.gmail.description')}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="gmail-enabled">{t('settings.gmail.enableToggle')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.gmail.enableDescription')}
              </p>
            </div>
            <Switch
              id="gmail-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="gmail-maton-api-key">{t('settings.gmail.matonApiKey')}</Label>
            <div className="flex gap-2">
              <Input
                id="gmail-maton-api-key"
                type={showKey ? 'text' : 'password'}
                value={form.matonApiKey}
                onChange={(event) => patch({ matonApiKey: event.target.value })}
                placeholder="..."
                spellCheck={false}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setShowKey((prev) => !prev)}
                title={
                  showKey ? t('settings.gmail.hideKey') : t('settings.gmail.showKey')
                }
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('settings.gmail.matonApiKeyHelp')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gmail-connection-id">{t('settings.gmail.connectionId')}</Label>
            <Input
              id="gmail-connection-id"
              value={form.matonConnectionId}
              onChange={(event) => patch({ matonConnectionId: event.target.value })}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-sm text-muted-foreground">
              {t('settings.gmail.connectionIdHelp')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gmail-gateway-base-url">{t('settings.gmail.gatewayBaseUrl')}</Label>
            <Input
              id="gmail-gateway-base-url"
              value={form.gatewayBaseUrl}
              onChange={(event) => patch({ gatewayBaseUrl: event.target.value })}
              placeholder={DEFAULT_FORM.gatewayBaseUrl}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="gmail-control-base-url">{t('settings.gmail.controlBaseUrl')}</Label>
            <Input
              id="gmail-control-base-url"
              value={form.controlBaseUrl}
              onChange={(event) => patch({ controlBaseUrl: event.target.value })}
              placeholder={DEFAULT_FORM.controlBaseUrl}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !canTest}
              title={canTest ? undefined : t('settings.gmail.testDisabledHint')}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.gmail.test')}
            </Button>
            {dirty && (
              <span className="text-sm text-muted-foreground">
                {t('settings.gmail.unsaved')}
              </span>
            )}
          </div>

          {saveMessage && (
            <Alert variant={saveMessage.ok ? 'default' : 'destructive'}>
              <div className="flex items-center gap-2">
                {saveMessage.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <AlertDescription>{t(saveMessage.key)}</AlertDescription>
              </div>
            </Alert>
          )}

          {testResult && (
            <Alert variant={testResult.ok ? 'default' : 'destructive'}>
              <div className="flex items-start gap-2">
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4" />
                )}
                <div className="min-w-0 space-y-1">
                  <AlertDescription>
                    {t(`settings.gmail.result.${testResult.message}`)}
                  </AlertDescription>
                  {testResult.endpoint && (
                    <p className="break-all text-xs text-muted-foreground">
                      {testResult.endpoint}
                    </p>
                  )}
                  {testResult.reply && (
                    <p className="break-all text-xs text-muted-foreground">
                      {t('settings.gmail.reply')}: {testResult.reply}
                    </p>
                  )}
                </div>
              </div>
            </Alert>
          )}

          <Alert>
            <AlertDescription>{t('settings.gmail.warning')}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  )
}
