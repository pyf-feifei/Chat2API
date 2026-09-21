/**
 * Connectivity probe for the optional vision model used by the Z.ai captcha solver.
 *
 * The probe sends a tiny synthetic PNG containing the number "42" and asks the
 * model to read it back. This exercises base URL, API key, model name and actual
 * image understanding in one round-trip, which is exactly what the solver needs.
 *
 * Kept dependency-free (global fetch) so it can run inside the Electron main
 * process without pulling in any image library.
 */

import type { CaptchaVisionConfig, CaptchaVisionTestResult } from '../../shared/types.ts'

/** 160x60 PNG: white background, thin grey frame, large black "42". */
export const CAPTCHA_VISION_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAAA8CAIAAABuCSZCAAAEcElEQVR42u2dXSh7bxzAz7GRpLkxEyXNlUjLjWsXShmjpjYrii0rDWVIrHlfCptdyUYurBUXGyMyTSlClJrUWqaILMR2sWWvv4t/6fzOjO3/24vN93N3vntedvbZ8+w8z/luQ/1+PwIkLynwEoBgAAQDIBgAwQAIBkAwgIUY7IGTkxN4dRKLioqKMAQHqwD8TIINSJii4TMYAMHRw+12l5WVoRiEQuG3te7u7qampmprawsLC0kkUlpaGoVCodFofD5fo9F4vd5fZNgfhOPjY/8PYGRkBPeEe3p6vij/+PjI4XAIBMIXp0ylUrVarT+5CObrR4/gq6uriYmJ0MufnZ2VlJSoVKqvx6jFYqmvrx8cHIQpOp74fL7W1laXyxViebPZXFVV9fLyEmL5ycnJmZkZEBw3ZDJZWGvxjo6Ot7e3sLoYGBgwm80gOA5YLBaRSBR6+aOjI71ejwvSaLStrS2bzeZ0Os/Pz1ksVuAV3Pj4+C/dyYovPB7P4XCEXl6lUuEipaWlh4eHGRkZ/x2Wl5er1WoSibSwsIAtptPpPB4PkUiEERw7FAqFwWAIq8ru7i4uIhaLP+x+MDY2lpLy1ym/vr7e3NzAFB07Hh4eent7w6ricDgsFgs2QiAQqqurA0vm5ORQqVRc0Gq1whQdO/h8vs1m+zhEUfTbtEC32y2RSB4wpKamZmZmflo4PT0dFwkc6CA4WqjVap1Oh41wuVyFQvF1raysrL6+vlDa93q9t7e3uGBubi5M0bHg+fm5q6sLG2GxWHV1dRHswmAw2O12bKSgoCAvLw8Ex4LOzs6np6ePw+zsbLlcHtkuAhdFNTU1sA6OBZubm2q1GhuRy+VkMjmCXUil0oODg79OPiVFIBCA4Khjt9v5fD42QqfT2Wx2BLvQaDSBF+csFqu4uBgERx2hUHh/f/9xSCKR5ufnI9j+9vY2m83G3YEgk8mzs7MIAnvRUWZ/f1+pVGIj09PT+fn5kWp/Z2enoaHh/f0dF1cqlRQKBQRHF6fTyePxsCvdyspKLpcbqfbX19cZDEagXbFYHNnrcxD8OUNDQ9fX19g9B4VCgaJoRBpfXV1lMpmBNxwFAsHw8DCCQMpOlDk9PZXJZLhlTFFRUUQaX1lZaWpq8ng8uHh3d3fEV18g+BNcLldbW5vP50MwWbq4jY7/zfLycktLS2Beh0gkkkqlyK8iXjlZFxcX//7kJRJJYMtra2uBOVkois7NzfmTl2C+iHF8Y0Wj2b29PQ6Hgxu7BAJhaWmpubkZQeCrK4mMyWRqbGzEXVURiUS1Ws1kMhEE8qITGYfDwWAwAtOyFhcXf63dpBLc399vMplwwfb29t85MydM4jvu9jASJPHdaDTicnFCR6/XQ+L7T2d0dBS74gKSaoq2Wq1arRZcJq3gjY0Nt9sNLpNWcLg5tiA4wbi8vASRibrRQafTv93zMhqNIBK+4Q+CARAMgGAABAMgGADBwD+vg+HnKpMAFP6UA6ZoAAQDIBgAwQAIBkAwgOUPEDo8d5NsgqIAAAAASUVORK5CYII='

const PROBE_EXPECTED = '42'
const PROBE_TIMEOUT_MS = 60_000

/** Matches the UA used by scripts/zai-captcha/solve.py (some gateways 403 default urllib/Node UA). */
const PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function normalizeBaseUrl(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '')
}

export function describeCaptchaVisionEndpoint(raw: string): string {
  const base = normalizeBaseUrl(raw)
  return base ? `${base}/chat/completions` : ''
}

/**
 * Round-trip probe: sends the probe image and expects the model to read "42".
 * Never throws - returns a structured result suitable for direct display in UI.
 */
export async function testCaptchaVisionConnection(
  config: CaptchaVisionConfig
): Promise<CaptchaVisionTestResult> {
  const base = normalizeBaseUrl(config?.baseUrl)
  const model = (config?.model || '').trim()
  const apiKey = (config?.apiKey || '').trim()

  if (!base) {
    return { ok: false, message: 'missingBaseUrl' }
  }
  if (!apiKey) {
    return { ok: false, message: 'missingApiKey' }
  }
  if (!model) {
    return { ok: false, message: 'missingModel' }
  }

  const endpoint = `${base}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const payload = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read the number printed in this image. Reply with that number only.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${CAPTCHA_VISION_PROBE_PNG_BASE64}`,
              },
            },
          ],
        },
      ],
      // Reasoning models spend the first tokens on chain-of-thought; give them room.
      max_tokens: 4000,
      temperature: 0,
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': PROBE_UA,
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const raw = await response.text()

    if (!response.ok) {
      return {
        ok: false,
        message: 'httpError',
        endpoint,
        reply: `${response.status} ${response.statusText} ${raw.slice(0, 300)}`.trim(),
      }
    }

    let content: string | null = null
    try {
      const parsed = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string | null } }>
      }
      content = parsed?.choices?.[0]?.message?.content ?? null
    } catch {
      return { ok: false, message: 'badJson', endpoint, reply: raw.slice(0, 300) }
    }

    if (!content || !content.trim()) {
      // Almost always a reasoning model that burned the whole token budget on CoT.
      return { ok: false, message: 'emptyContent', endpoint, reply: '' }
    }

    const reply = content.trim().slice(0, 300)
    const digits = reply.replace(/[^0-9]/g, '')
    if (digits.includes(PROBE_EXPECTED)) {
      return { ok: true, message: 'ok', endpoint, reply }
    }
    return { ok: false, message: 'mismatch', endpoint, reply }
  } catch (error) {
    const err = error as { name?: string; message?: string }
    if (err?.name === 'AbortError') {
      return { ok: false, message: 'timeout', endpoint }
    }
    return {
      ok: false,
      message: 'networkError',
      endpoint,
      reply: (err?.message || String(error)).slice(0, 300),
    }
  } finally {
    clearTimeout(timer)
  }
}
