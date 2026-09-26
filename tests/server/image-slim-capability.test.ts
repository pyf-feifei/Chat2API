/**
 * Image slimming capability resolution, plus the corpus measurement that
 * motivated the whole track.
 *
 * Every entry in `VISION_PROVIDER_DEFAULTS` is a claim about an adapter, so
 * every entry is pinned here against the adapter source. A grep count is a
 * starting point for review, not evidence: Kimi and MiniMax both mention
 * `image_url` and both are `false`, because their only reference is a focus
 * system message and neither adapter ever uploads the image.
 *
 * Design: `docs/superpowers/specs/2026-09-26-provider-neutral-image-slimming-design.md`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  isVisionProvider,
  VISION_PROVIDER_DEFAULTS,
  resetUnlistedProviderWarnings,
} from '../../src/main/proxy/imageSlimPolicy.ts'
import { measureRawCapture } from '../../scripts/compress/extract-corpus.mjs'
import type { Provider } from '../../src/shared/types.ts'
import { FIXTURES } from '../proxy/compression/fixtures.ts'

const repoRoot = process.cwd()

function providerStub(id: string, overrides: Partial<Provider> = {}): Pick<Provider, 'id' | 'modelCapabilities'> {
  return { id, modelCapabilities: {}, ...overrides } as Pick<Provider, 'id' | 'modelCapabilities'>
}

function readAdapter(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8')
}

// ---------------------------------------------------------------------------
// Corpus measurement — the 90.7% figure
// ---------------------------------------------------------------------------

/**
 * This assertion reads the RAW capture, not the corpus.
 *
 * The first version of this test computed the share from `FIXTURES` and failed
 * at 0.1%. That was correct behavior exposing a wrong test: `redactDataUrls`
 * replaces every inline base64 payload with a short digest, so a 200 KB
 * screenshot becomes ~30 characters. The image share is a property of the raw
 * capture and cannot survive redaction.
 */
test('the raw capture shows that image payloads dominate the estimated token budget', () => {
  const raw = measureRawCapture()
  assert.ok(raw, 'raw capture fixture is missing; the measurement cannot run')

  assert.equal(raw.toolOutputs, 181, 'tool output count changed; re-verify the measurement')
  assert.equal(raw.imageOutputs, 17, 'image-bearing output count changed')
  assert.equal(raw.totalTokens, 787_376, 'total estimated tokens changed')
  assert.equal(raw.imageTokens, 714_462, 'image-estimated tokens changed')

  // This threshold is EXPECTED TO FAIL once provider-neutral image slimming
  // lands, and that failure is the point: it means the share moved and this
  // number should be updated in the same commit that records the post-rollout
  // measurement. Do not delete or weaken this assertion.
  //
  // Track: docs/superpowers/plans/2026-09-26-provider-neutral-image-slimming.md
  // Task 0.2 / Task 6.2.
  assert.ok(
    raw.imageShare > 0.8,
    `raw image share drifted to ${(raw.imageShare * 100).toFixed(1)}%. `
      + `If provider-neutral image slimming just landed, update this threshold to the `
      + `measured post-rollout value.`,
  )
})

test('the corpus cannot be used for the image share; only the raw capture can', () => {
  // This is the inverse of the assertion above, and it exists because the first
  // version of this file got it wrong. Two independent facts make the corpus
  // unusable for the share measurement:
  //
  //   1. `chars` is recorded AFTER redaction, so no fixture retains its original
  //      size and the 200 KB payloads left no trace.
  //   2. even the token count collapses, because the digest is ~30 characters.
  //
  // Locking the consequence in means the next person to try this gets a clear
  // failure instead of a silently wrong 0.1%.
  const captured = FIXTURES.filter((fixture) => fixture.source !== 'synthetic')
  const imageTokens = captured
    .filter((fixture) => fixture.image)
    .reduce((sum, fixture) => sum + fixture.estimatedTokens, 0)
  const totalTokens = captured.reduce((sum, fixture) => sum + fixture.estimatedTokens, 0)
  const corpusShare = imageTokens / totalTokens

  assert.ok(
    corpusShare < 0.2,
    `the redacted corpus reports an image share of ${(corpusShare * 100).toFixed(1)}%. `
      + `If this is now high, the corpus generator changed and measureRawCapture needs revisiting.`,
  )

  const raw = measureRawCapture()
  assert.ok(raw)
  assert.ok(
    raw.imageShare > corpusShare * 10,
    'the raw capture and the redacted corpus should disagree by an order of magnitude',
  )
})

test('the corpus records chars consistently with the redacted text it keeps', () => {
  // `chars` is post-redaction and pre-clip. If the generator ever starts
  // recording the raw size, this fails and the measurement story needs updating.
  for (const fixture of FIXTURES) {
    if (fixture.chars <= fixture.text.length) continue
    assert.ok(
      fixture.text.includes('corpus clip'),
      `${fixture.name} is shorter than its recorded chars but has no clip marker`,
    )
  }
})

// ---------------------------------------------------------------------------
// Capability defaults
// ---------------------------------------------------------------------------

test('vision defaults are declared for every builtin provider id', () => {
  const declared = Object.keys(VISION_PROVIDER_DEFAULTS).sort()
  assert.deepEqual(
    declared,
    ['deepseek', 'glm', 'kimi', 'm365-copilot', 'mimo', 'minimax', 'perplexity', 'qwen', 'qwen-ai', 'zai'],
    'the capability table must cover every builtin provider explicitly, '
      + 'including the ones that are false, so an unlisted provider is a real omission',
  )
})

test('adapters that transport images are declared vision: true', () => {
  const transportsImages: Array<[string, string]> = [
    ['glm', 'src/main/proxy/adapters/glm.ts'],
    ['qwen-ai', 'src/main/proxy/adapters/qwen-ai.ts'],
    ['zai', 'src/main/proxy/adapters/zai-files.ts'],
    ['mimo', 'src/main/proxy/adapters/mimo-files.ts'],
    ['m365-copilot', 'src/main/proxy/adapters/m365.ts'],
  ]

  for (const [id, adapterPath] of transportsImages) {
    assert.equal(VISION_PROVIDER_DEFAULTS[id], true, `${id} must default to true`)
    const source = readAdapter(adapterPath)
    assert.match(
      source,
      /image_url|input_image/,
      `${adapterPath} no longer handles image parts; re-verify ${id}'s capability default`,
    )
  }
})

test('adapters that only mention image_url without transporting it are false', () => {
  // The regression this test exists for: a grep count would report one hit each
  // for these two and wrongly suggest they consume images.
  assert.equal(VISION_PROVIDER_DEFAULTS.kimi, false)
  assert.equal(VISION_PROVIDER_DEFAULTS.minimax, false)

  const kimi = readAdapter('src/main/proxy/adapters/kimi.ts')
  assert.match(
    kimi,
    /\['file', 'image_url'\]\.includes\(v\.type\)/,
    'kimi.ts:628 reference changed; re-verify whether Kimi now uploads images',
  )
  // A focus heuristic is the whole story for Kimi. If an upload path appears,
  // this assertion is the signal to revisit.
  assert.doesNotMatch(
    kimi,
    /imageUrls|imageRefs|uploadImage|files\/upload/i,
    'kimi.ts gained image transport code; the false default is now wrong',
  )

  const minimax = readAdapter('src/main/proxy/adapters/minimax.ts')
  assert.doesNotMatch(
    minimax,
    /imageUrls|imageRefs|uploadImage|files\/upload/i,
    'minimax.ts gained image transport code; the false default is now wrong',
  )
})

test('adapters with no image handling at all are false', () => {
  for (const [id, adapterPath] of [
    ['deepseek', 'src/main/proxy/adapters/deepseek.ts'],
    ['perplexity', 'src/main/proxy/adapters/perplexity.ts'],
    ['qwen', 'src/main/proxy/adapters/qwen.ts'],
  ] as const) {
    assert.equal(VISION_PROVIDER_DEFAULTS[id], false, `${id} must default to false`)
    const source = readAdapter(adapterPath)
    assert.doesNotMatch(
      source,
      /image_url|input_image/,
      `${adapterPath} now handles image parts; the false default is stale`,
    )
  }
})

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

test('model-level capability overrides the provider default', () => {
  assert.equal(isVisionProvider(providerStub('deepseek'), 'deepseek-chat'), false)
  assert.equal(
    isVisionProvider(providerStub('deepseek', { modelCapabilities: { 'deepseek-chat': { vision: true } } }), 'deepseek-chat'),
    true,
    'an explicit per-model opt-in must beat the provider default',
  )
  assert.equal(
    isVisionProvider(providerStub('qwen-ai', { modelCapabilities: { 'qwen-long': { vision: false } } }), 'qwen-long'),
    false,
    'an explicit per-model opt-out must beat the provider default',
  )
})

test('an undeclared model falls back to the provider default', () => {
  const provider = providerStub('qwen-ai', { modelCapabilities: { 'qwen-other': { vision: false } } })
  assert.equal(isVisionProvider(provider, 'qwen-plus'), true,
    'qwen-plus is not declared, so the provider default applies')
})

test('an unknown provider is false, which is the safe direction', () => {
  resetUnlistedProviderWarnings()
  assert.equal(isVisionProvider(providerStub('my-custom-provider'), 'some-model'), false)
  assert.equal(isVisionProvider(providerStub(''), ''), false)
})

test('an empty modelCapabilities object does not break resolution', () => {
  assert.equal(isVisionProvider({ id: 'glm', modelCapabilities: {} }, 'glm-4'), true)
  assert.equal(isVisionProvider({ id: 'unknown', modelCapabilities: {} }, 'x'), false)
})

// ---------------------------------------------------------------------------
// The flag gates slimming, so it must describe the adapter and not the vendor
// ---------------------------------------------------------------------------

test('a vision flag of true means the adapter forwards the image, not that the vendor supports vision', () => {
  // M365 is the shape this guards: the adapter converts `image_url` into an
  // attachment, so `true` is about transport. The table's doc comment states the
  // same distinction; this test fails if someone reinterprets it as a vendor
  // capability claim.
  const m365 = readAdapter('src/main/proxy/adapters/m365.ts')
  assert.match(
    m365,
    /part\.type === 'image_url'[\s\S]{0,200}attachments\.push/,
    'm365.ts no longer converts image_url into an attachment',
  )
  assert.equal(VISION_PROVIDER_DEFAULTS['m365-copilot'], true)
})
