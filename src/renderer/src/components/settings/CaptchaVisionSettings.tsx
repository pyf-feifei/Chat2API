import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Eye, EyeOff, Loader2, ScanEye, CheckCircle2, XCircle, Wand2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import type { CaptchaVisionConfig, CaptchaVisionTestResult } from '@/types/electron'

const RECOMMENDED_MODELS = [
  'inclusionai/ling-3.0-flash-vl:free',
  'qwen/qwen2.5-vl-32b-instruct:free',
  'google/gemma-3-27b-it:free',
]

export function CaptchaVisionSettings() {
  const { t } = useTranslation()
  const { config, updateConfig, fetchConfig } = useSettingsStore()

  const [form, setForm] = useState<CaptchaVisionConfig>({
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
  })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<CaptchaVisionTestResult | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; key: string } | null>(null)
  const [dirty, setDirty] = useState(false)

  // Load once the store has fetched the config; do not clobber in-progress edits.
  useEffect(() => {
    const stored = config?.captchaVision
    if (!stored) return
    setForm((prev) => (dirty ? prev : { ...stored }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.captchaVision])

  useEffect(() => {
    if (!config) {
      void fetchConfig()
    }
  }, [config, fetchConfig])

  const patch = (updates: Partial<CaptchaVisionConfig>) => {
    setDirty(true)
    setSaveMessage(null)
    setTestResult(null)
    setForm((prev) => ({ ...prev, ...updates }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMessage(null)
    try {
      await updateConfig({ captchaVision: { ...form } })
      setDirty(false)
      setSaveMessage({ ok: true, key: 'settings.captchaVision.saveSuccess' })
    } catch {
      setSaveMessage({ ok: false, key: 'settings.captchaVision.saveError' })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.config.testCaptchaVision({
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
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

  const canTest = Boolean(form.baseUrl.trim() && form.apiKey.trim() && form.model.trim())

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <ScanEye className="h-5 w-5" />
            {t('settings.captchaVision.title')}
          </CardTitle>
          <CardDescription>{t('settings.captchaVision.description')}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="captcha-vision-enabled">
                {t('settings.captchaVision.enableToggle')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.captchaVision.enableDescription')}
              </p>
            </div>
            <Switch
              id="captcha-vision-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="captcha-vision-base-url">
              {t('settings.captchaVision.baseUrl')}
            </Label>
            <Input
              id="captcha-vision-base-url"
              value={form.baseUrl}
              onChange={(event) => patch({ baseUrl: event.target.value })}
              placeholder="https://example.com/v1"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-sm text-muted-foreground">
              {t('settings.captchaVision.baseUrlHelp')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="captcha-vision-api-key">
              {t('settings.captchaVision.apiKey')}
            </Label>
            <div className="flex gap-2">
              <Input
                id="captcha-vision-api-key"
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(event) => patch({ apiKey: event.target.value })}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setShowKey((prev) => !prev)}
                title={
                  showKey
                    ? t('settings.captchaVision.hideKey')
                    : t('settings.captchaVision.showKey')
                }
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="captcha-vision-model">{t('settings.captchaVision.model')}</Label>
            <Input
              id="captcha-vision-model"
              value={form.model}
              onChange={(event) => patch({ model: event.target.value })}
              placeholder="inclusionai/ling-3.0-flash-vl:free"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex flex-wrap gap-2 pt-1">
              {RECOMMENDED_MODELS.map((model) => (
                <Button
                  key={model}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => patch({ model })}
                  title={t('settings.captchaVision.applyModel')}
                >
                  <Wand2 className="mr-1 h-3 w-3" />
                  {model}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('settings.captchaVision.modelHelp')}
            </p>
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
              title={
                canTest ? undefined : t('settings.captchaVision.testDisabledHint')
              }
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.captchaVision.test')}
            </Button>
            {dirty && (
              <span className="text-sm text-muted-foreground">
                {t('settings.captchaVision.unsaved')}
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
                    {t(`settings.captchaVision.result.${testResult.message}`)}
                  </AlertDescription>
                  {testResult.endpoint && (
                    <p className="break-all text-xs text-muted-foreground">
                      {testResult.endpoint}
                    </p>
                  )}
                  {testResult.reply && (
                    <p className="break-all text-xs text-muted-foreground">
                      {t('settings.captchaVision.reply')}: {testResult.reply}
                    </p>
                  )}
                </div>
              </div>
            </Alert>
          )}

          <Alert>
            <AlertDescription>{t('settings.captchaVision.warning')}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  )
}
