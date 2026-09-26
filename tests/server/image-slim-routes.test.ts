/**
 * Route wiring — image slimming Phase 4.
 *
 * The existing suite at `replay-slimming-and-busy-cap.test.ts:333` asserts that
 * both failover routes consult the slim mode on every attempt, and it reads the
 * route source to do it. This file extends that idea to the provider-neutral
 * path: both routes must call `resolveImageSlimPolicy`, and neither may keep
 * gating on `QwenAiAdapter.isQwenAiProvider` at the request-construction site.
 *
 * Source-reading assertions are a last resort, but they are the only way to
 * check a wiring decision that has no runtime effect without standing up a
 * full proxy, a provider and an account. They are paired with the behavioral
 * tests in the other files so a rename cannot silently pass.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ROUTES = ['src/main/proxy/routes/chat.ts', 'src/main/proxy/routes/responses.ts']
const SLIMMING = 'src/main/proxy/replayImageSlimming.ts'

function read(relative: string): string {
  return fs.readFileSync(relative, 'utf8')
}

/** The block that builds the per-attempt request. */
function requestConstructionSite(source: string): string {
  const marker = 'requestForAttempt'
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, 'could not find the request construction site')
  return source.slice(Math.max(0, at - 700), at + 400)
}

for (const route of ROUTES) {
  test(`${route} resolves the image slim policy per attempt`, () => {
    assert.match(read(route), /resolveImageSlimPolicy\(/,
      `${route} must call resolveImageSlimPolicy`)
  })

  test(`${route} no longer gates the request on the Qwen provider check`, () => {
    const site = requestConstructionSite(read(route))
    assert.doesNotMatch(
      site,
      /QwenAiAdapter\.isQwenAiProvider\(selection\.provider\)\s*&&?\s*shouldSlimQwenAiAttemptImages/,
      `${route} still gates slimming on the Qwen provider check:\n${site}`,
    )
    assert.doesNotMatch(
      site,
      /shouldSlimQwenAiAttemptImages\(/,
      `${route} still calls the Qwen-only trigger directly`,
    )
  })

  test(`${route} passes the resolved policy into the transform`, () => {
    assert.match(
      read(route),
      /slimQwenAiReplayImages\(\s*\w+\.messages,\s*\w+/,
      `${route} must pass the resolved policy so env reading stays out of the transform`,
    )
  })
}

test('the busy flag is still only raised by a Qwen busy verdict', () => {
  // `on-busy` is a Qwen STS-quota defense. The reactive signal must stay keyed
  // to that verdict; another provider's failure must not arm it.
  for (const route of ROUTES) {
    const source = read(route)
    assert.match(source, /errorCode === 'qwen_ai_upstream_busy'/,
      `${route} should still key the busy flag on the Qwen busy verdict`)
  }
})

test('the transform keeps the newest image-bearing message unconditionally', () => {
  // Defense in depth. The policy clamps keepLast to 1, and the transform
  // independently guarantees it, so a caller that constructs keep counts by
  // hand still cannot slim the current turn's reference image.
  const source = read(SLIMMING)
  assert.match(
    source,
    /newest|latest|keepSet\.add|imageBearing\.length - 1/,
    'the transform should name the newest-image invariant in a comment or code',
  )
})

test('the transform reads no environment variables of its own', () => {
  // Env reading belongs in the policy layer. If the transform reads process.env
  // again, a caller that passes explicit keep counts is silently ignored.
  const source = read(SLIMMING)
  const transformBody = source.slice(source.indexOf('export function slimQwenAiReplayImages'))
  assert.doesNotMatch(
    transformBody,
    /process\.env/,
    'the transform must not read process.env; the policy supplies every value',
  )
})
