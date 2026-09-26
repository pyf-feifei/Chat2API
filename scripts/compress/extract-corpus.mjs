#!/usr/bin/env node
/**
 * Extract a golden compression corpus from real captured proxy payloads.
 *
 * The corpus exists so that Phase 0 of
 * `docs/superpowers/plans/2026-09-26-upstream-compression-backends.md` can
 * freeze current `safe`-mode behavior before any new behavior is added, and
 * so the cross-backend parity suite (Task 5.1) compares the three backends on
 * shapes that actually occur rather than on hand-written strings.
 *
 * Sources are real captures already in the workspace:
 *   - `.testimg/req_real.json`       17-message Codex chat request
 *   - `codex-replay-payload.json`    435-item Responses replay
 *   - `codex-session-*.md`           full Codex session transcript
 *   - `dev-data/*.log`               proxy log captures
 *
 * Every extracted string is redacted, and the redaction is verified before the
 * corpus is written. A leak aborts the run.
 *
 * Usage:
 *   node scripts/compress/extract-corpus.mjs            # write fixtures.ts
 *   node scripts/compress/extract-corpus.mjs --stats    # report only
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const statsOnly = process.argv.includes('--stats')

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92)

/**
 * Replace the payload of an inline data URL with a short synthetic token.
 *
 * A content-derived digest is kept in the replacement so N distinct screenshots
 * stay N distinct fixtures after redaction instead of collapsing into one.
 * Without it the 17 image-bearing tool outputs in `codex-replay-payload.json`
 * all reduce to the same string and the dedupe drops 16 of them.
 */
function redactDataUrls(value) {
  return value.replace(
    new RegExp('data:([a-z0-9.+-]+/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\\s]{64,})', 'gi'),
    (_match, mime, payload) => {
      const digest = createHash('sha256').update(payload).digest('hex').slice(0, 8)
      return `data:${mime};base64,<BASE64_${digest.toUpperCase()}>`
    },
  )
}

// A drive letter must not be preceded by an alphanumeric or a backslash. The
// alphanumeric rule stops the `p:` in `http://` from being read as a drive; the
// backslash rule stops the `n:` in regex source such as `\\n:\\d+` from being
// read as one, which would otherwise mangle real code into `n:<DIR>`.
// An intermediate path segment may contain spaces but must be immediately
// followed by a separator; only the final segment excludes whitespace. That
// keeps `C:\Program Files\nodejs\node.exe` intact while stopping
// `C:\a\b failed because the token expired` from swallowing the prose.
//
// Written as regex literals on purpose. Building these from concatenated
// strings silently produced `\\r` instead of `\r` inside the character classes,
// which excluded the letters r and n and truncated `package-lock.json` to
// `package-lock.jso`.
const WINDOWS_PATH = /(?<![A-Za-z0-9\\])[A-Za-z]:[\\/]+(?:[^\\/:\r\n"'`<>|*?]+[\\/]+)*[^\\/:\r\n"'`<>|*?\s]*/g
const POSIX_PATH = /\/(?:Users|home)\/[^\r\n"'`<>|]*?(?=[/\s"'`<>|]|$)/g

function collapseWindowsPath(match) {
  // Plain regex literal. An earlier version interpolated `BS` here, which made
  // the split run on the literal characters `'`, ` `, `+`, `B`, `S` and `/`,
  // so a path never split into segments and was returned unchanged.
  const segments = match.split(/[\\/]+/).filter(Boolean)
  if (segments.length < 2) return match
  return segments[0] + BS + segments.slice(1).map(() => '<DIR>').join(BS)
}

function collapsePosixPath(match) {
  const segments = match.split('/').filter(Boolean)
  // `/Users/<name>` is already a leak at two segments: the account name is the
  // sensitive part, not the home directory.
  if (segments.length < 2) return match
  return '/' + segments[0] + '/' + segments.slice(1).map(() => '<DIR>').join('/')
}

function redactPaths(value) {
  return value.replace(WINDOWS_PATH, collapseWindowsPath).replace(POSIX_PATH, collapsePosixPath)
}

const SECRET_PATTERNS = [
  [new RegExp(BS + 'b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}' + BS + 'b', 'g'), '<SECRET>'],
  [new RegExp(BS + 'bBearer' + BS + 's+[A-Za-z0-9._~+/-]{20,}=*', 'g'), 'Bearer <SECRET>'],
  [new RegExp(BS + 'beyJ[A-Za-z0-9._-]{40,}', 'g'), '<JWT>'],
  [new RegExp(BS + 'b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' + BS + '.[A-Za-z]{2,}' + BS + 'b', 'g'), '<EMAIL>'],
  [new RegExp(BS + 'b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}' + BS + 'b', 'g'), '<SECRET>'],
  [new RegExp(BS + 'b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' + BS + 'b', 'gi'), '<UUID>'],
  // Credential-bearing CLI flags observed in the MiMo login capture.
  [new RegExp('(--(?:password|token|secret|api[-_]?key))' + BS + 's+\\S+', 'gi'), '$1 <SECRET>'],
]

/** Named credentials that appear in this workspace's captures. */
const LITERAL_SECRETS = [
  ['MY_WEBSTORE_PROXY_TOKEN', '<SECRET>'],
  ['MY_PROXY_TOKEN', '<SECRET>'],
]

function redactSecrets(value) {
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  for (const [literal, replacement] of LITERAL_SECRETS) {
    out = out.split(literal).join(replacement)
  }
  return out
}

/**
 * Full redaction chain.
 *
 * Order matters. Some log captures interleave control bytes (ANSI colour
 * resets, progress output) into the middle of paths and credentials. Stripping
 * them FIRST is what makes a path and an email visible to the patterns above.
 * Running the patterns first silently missed both, because no pattern can match
 * across a control byte.
 */
function redact(text, { collapseNewlines = false } = {}) {
  let out = String(text)
  out = out.replace(
    new RegExp('[' + BS + 'u0000-' + BS + 'u0008' + BS + 'u000B' + BS + 'u000C' + BS + 'u000E-' + BS + 'u001F]', 'g'),
    '',
  )
  if (collapseNewlines) out = out.replace(new RegExp(BS + 'r' + BS + 'n', 'g'), BS + 'n')
  out = redactDataUrls(out)
  out = redactPaths(out)
  out = redactSecrets(out)
  return out
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Mirror `estimateTextTokens` in `upstreamTokenOptimizer.ts`. */
function estimateTokens(value) {
  let ascii = 0
  let nonAscii = 0
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) || 0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 3) + nonAscii
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        if (part.type === 'text' || part.text) return part.text || ''
        return JSON.stringify(part)
      })
      .join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

function hasImagePart(content) {
  if (typeof content === 'string') {
    return new RegExp('data:image/[a-z0-9.+-]+;base64,', 'i').test(content.slice(0, 400))
  }
  if (!Array.isArray(content)) return false
  return content.some(
    (part) => part && typeof part === 'object'
      && ['input_image', 'image_url', 'image'].includes(part.type),
  )
}

function isJsonLike(text) {
  const trimmed = text.trimStart()[0]
  return trimmed === '[' || trimmed === '{'
}

function isStackTrace(text) {
  return text.includes('Traceback (most recent call last)')
    || /\n {4}at [\w.$<>]+ \(/.test(text)
    || /\n\s+at [\w.$<>]+:\d+:\d+/.test(text)
}

function hasCjk(text) {
  return new RegExp('[' + BS + 'u4e00-' + BS + 'u9fff]').test(text)
}

/**
 * Some captures were written with the wrong codec and contain CJK bytes
 * reinterpreted as Latin-1. These are real payloads the proxy forwarded, and
 * `estimateTextTokens` charges one token per non-ASCII codepoint, so a mojibake
 * block estimates several times higher than the text it was meant to be.
 */
function hasMojibake(text) {
  return new RegExp('[ÃÂå¿ï][' + BS + 'u0080-' + BS + 'u00bf]|锟斤拷').test(text)
}

function hasRepeatedLineRun(text, minimum = 3) {
  const lines = text.split('\n')
  let index = 0
  while (index < lines.length) {
    let end = index + 1
    while (end < lines.length && lines[end] === lines[index]) end += 1
    if (end - index >= minimum && lines[index].trim() !== '') return true
    index = end
  }
  return false
}

/** Truncate a long capture while keeping both ends, for fixture file size. */
function clip(text, limit = 24000) {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return text.slice(0, head)
    + '\n[...corpus clip: ' + (text.length - limit) + ' chars omitted...]\n'
    + text.slice(-tail)
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

const fixtures = []
const seen = new Set()

function addFixture(name, text, meta = {}) {
  if (typeof text !== 'string' || text.length === 0) return
  if (seen.has(text)) return
  seen.add(text)
  fixtures.push({
    name,
    text: clip(text),
    chars: text.length,
    lines: text.split('\n').length,
    estimatedTokens: estimateTokens(text),
    ...meta,
  })
}

function describe(text) {
  return {
    image: hasImagePart(text),
    json: isJsonLike(text),
    trace: isStackTrace(text),
    cjk: hasCjk(text),
    mojibake: hasMojibake(text),
    repeated: hasRepeatedLineRun(text),
  }
}

function collectFromChatRequest(file, label) {
  const filePath = path.join(repoRoot, file)
  if (!fs.existsSync(filePath)) {
    console.warn('[corpus] skip missing ' + file)
    return
  }
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const messages = payload.messages || []
  let toolMessages = 0
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool' && message.role !== 'function') continue
    toolMessages += 1
    const raw = contentToText(message.content ?? message.output)
    const redacted = redact(raw)
    const image = hasImagePart(message.content ?? message.output)
    addFixture(label + '-tool-' + String(index).padStart(3, '0'), redacted, {
      source: file,
      ...describe(redacted),
      image,
    })
  }
  console.log('[corpus] ' + file + ': ' + messages.length + ' messages, ' + toolMessages + ' tool results')
}

function collectFromResponsesReplay(file, label) {
  const filePath = path.join(repoRoot, file)
  if (!fs.existsSync(filePath)) {
    console.warn('[corpus] skip missing ' + file)
    return
  }
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const items = payload.input || payload.messages || []
  let toolOutputs = 0
  for (const [index, item] of items.entries()) {
    const type = item.role || item.type
    if (type !== 'function_call_output' && type !== 'tool') continue
    toolOutputs += 1
    const raw = contentToText(item.output ?? item.content)
    const redacted = redact(raw)
    const image = hasImagePart(item.output ?? item.content)
    addFixture(label + '-out-' + String(index).padStart(3, '0'), redacted, {
      source: file,
      ...describe(redacted),
      image,
    })
  }
  console.log('[corpus] ' + file + ': ' + items.length + ' items, ' + toolOutputs + ' tool outputs')
}

function collectFromSessionMarkdown(file, label) {
  const filePath = path.join(repoRoot, file)
  if (!fs.existsSync(filePath)) {
    console.warn('[corpus] skip missing ' + file)
    return
  }
  const raw = fs.readFileSync(filePath, 'utf8')
  // These transcripts have no fenced blocks. Real tool output lives in
  // `## Activity` sections as an indented PowerShell command plus its stdout.
  const sections = raw.split(new RegExp('^## Activity$', 'm')).slice(1)
  let taken = 0
  for (const [index, section] of sections.entries()) {
    if (section.length < 1500) continue
    const body = section.split(new RegExp('^## ', 'm'))[0]
    const redacted = redact(body)
    const flags = describe(redacted)
    if (!flags.cjk && !flags.mojibake && !flags.trace && !flags.repeated) continue
    addFixture(label + '-activity-' + String(index).padStart(3, '0'), redacted, {
      source: file,
      ...flags,
    })
    taken += 1
    if (taken >= 20) break
  }
  console.log('[corpus] ' + file + ': ' + sections.length + ' activity sections, ' + taken + ' kept')
}

function collectFromLogs(dir, label) {
  const dirPath = path.join(repoRoot, dir)
  if (!fs.existsSync(dirPath)) {
    console.warn('[corpus] skip missing ' + dir)
    return
  }
  const files = fs.readdirSync(dirPath).filter((name) => name.endsWith('.log'))
  for (const name of files) {
    const raw = fs.readFileSync(path.join(dirPath, name), 'utf8')
    const chunks = raw
      .split(new RegExp(BS + 'n(?=' + BS + 'd{4}-' + BS + 'd{2}-' + BS + 'd{2}[ T]' + BS + 'd{2}:' + BS + 'd{2})'))
      .filter((chunk) => chunk.length > 1500)
    let taken = 0
    for (const [index, chunk] of chunks.entries()) {
      const redacted = redact(chunk)
      const flags = describe(redacted)
      if (!flags.cjk && !flags.mojibake && !flags.trace && !flags.repeated) continue
      addFixture(label + '-' + name.replace(/\.log$/, '') + '-' + String(index).padStart(3, '0'), redacted, {
        source: dir + '/' + name,
        ...flags,
      })
      taken += 1
      if (taken >= 12) break
    }
    if (taken) console.log('[corpus] ' + dir + '/' + name + ': ' + taken + ' chunks kept')
  }
}

/**
 * Synthetic boundary fixtures. Not captured data, but the captures contain no
 * exact-threshold lengths and the compressor branches on `text.length < 128`
 * and `text.length <= maxChars`.
 */
function addBoundaryFixtures() {
  const line = (i) => 'line ' + i + ' of a balanced-mode boundary fixture'

  addFixture('boundary-127-chars', 'x'.repeat(127), {
    source: 'synthetic', boundary: 'below-compactToolText-floor',
  })
  addFixture('boundary-128-chars', 'x'.repeat(128), {
    source: 'synthetic', boundary: 'at-compactToolText-floor',
  })
  addFixture('boundary-129-chars', 'x'.repeat(129), {
    source: 'synthetic', boundary: 'above-compactToolText-floor',
  })
  addFixture('boundary-16000-chars', Array.from({ length: 1600 }, (_, i) => line(i)).join('\n'), {
    source: 'synthetic', boundary: 'at-balanced-maxChars',
  })
  addFixture('boundary-16001-chars', Array.from({ length: 1601 }, (_, i) => line(i)).join('\n'), {
    source: 'synthetic', boundary: 'above-balanced-maxChars',
  })
  addFixture('boundary-single-line-over-max', 'E' + 'x'.repeat(40000), {
    source: 'synthetic', boundary: 'single-line-payload-cannot-be-line-selected',
  })
  addFixture('boundary-marker-already-present',
    'dup line\n'.repeat(5) + '[Chat2API repeated identical line x5]\n' + 'dup line\n'.repeat(5), {
      source: 'synthetic', boundary: 'idempotence-guard',
    })
  addFixture('boundary-is-error-array', JSON.stringify([{
    is_error: true,
    text: 'Error: upstream rejected the request\n    at handle (src/main/proxy/forwarder.ts:1426:34)',
  }]), { source: 'synthetic', boundary: 'error-result-must-not-be-compacted' })
  addFixture('boundary-cjk-long', '这是一段用于测试压缩逻辑的中文工具输出，'.repeat(400), {
    source: 'synthetic', cjk: true, boundary: 'cjk-non-ascii-estimates',
  })
  // Real captures carry ~200 KB base64 screenshots inside tool results. The
  // redaction step collapses those to a short token, so a fixture at the real
  // scale is added here to keep the size branch covered.
  addFixture('boundary-inline-image-payload', JSON.stringify([{
    type: 'input_image',
    image_url: { url: 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUg'.repeat(8000), detail: 'high' },
  }]), { source: 'synthetic', image: true, boundary: 'inline-base64-image-scale' })
  addFixture('boundary-mojibake-cjk', '璇峰弬鑰冿紝鍙傝€冿紝鐒跺悗鍦ㄩ」鐩綰\n'.repeat(120), {
    source: 'synthetic', mojibake: true, boundary: 'codec-corrupted-non-ascii-estimates',
  })
}

// ---------------------------------------------------------------------------
// Raw capture measurement
// ---------------------------------------------------------------------------

/**
 * Measure the image share of a raw capture, before redaction.
 *
 * This cannot be measured from the corpus itself. `redactDataUrls` replaces
 * every inline base64 payload with a short digest, so a 200 KB screenshot
 * becomes ~30 characters and the image share of the redacted corpus collapses
 * to under 1%. The 90.7% figure is a property of the raw capture.
 *
 * The corpus can still show that the payloads were enormous, by comparing each
 * image fixture's pre-clip character count against its post-redaction length.
 * `test('redaction removed the bulk of every image fixture')` covers that.
 */
export function measureRawCapture(file = 'codex-replay-payload.json') {
  const filePath = path.join(repoRoot, file)
  if (!fs.existsSync(filePath)) return undefined

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const items = payload.input || payload.messages || []

  let totalTokens = 0
  let imageTokens = 0
  let toolOutputs = 0
  let imageOutputs = 0

  for (const item of items) {
    const type = item.role || item.type
    if (type !== 'function_call_output' && type !== 'tool') continue
    toolOutputs += 1

    const raw = contentToText(item.output ?? item.content)
    const tokens = estimateTokens(raw)
    totalTokens += tokens
    if (hasImagePart(item.output ?? item.content)) {
      imageOutputs += 1
      imageTokens += tokens
    }
  }

  if (toolOutputs === 0) return undefined
  return {
    file,
    toolOutputs,
    imageOutputs,
    totalTokens,
    imageTokens,
    imageShare: imageTokens / totalTokens,
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Runs on every emitted fixture's `text`, never on `name` or `source` (those
 * hold a local capture filename, which is provenance rather than data). A
 * failure here means a redaction rule regressed, and the corpus must not be
 * written.
 */
const LEAK_PATTERNS = {
  // A redacted Windows path still starts with a drive letter; the tell is that
  // its first segment is `<DIR>`. A path whose first real segment is still
  // visible (e.g. `C:\Users\...`) is a genuine partial redaction.
  'windows absolute path': /(?<![A-Za-z0-9\\])[A-Za-z]:\\(?!<DIR>)[^\s"']{3,}/,
  'posix home path': new RegExp('/(?:Users|home)/' + BS + '/(?!<DIR>)[^' + BS + 's"\']{3,}'),
  'email address': new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' + BS + '.[A-Za-z]{2,}'),
  'inline base64 run >200': new RegExp('[A-Za-z0-9+/]{200,}'),
  'bearer token': new RegExp('Bearer [A-Za-z0-9._~+/-]{20,}'),
  'jwt': new RegExp('eyJ[A-Za-z0-9._-]{40,}'),
  'api key literal': new RegExp(BS + 'b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}' + BS + 'b'),
}

function verifyRedaction() {
  const leaks = []
  const captured = fixtures.filter((f) => f.source !== 'synthetic')
  for (const fixture of captured) {
    for (const [label, pattern] of Object.entries(LEAK_PATTERNS)) {
      const match = fixture.text.match(pattern)
      if (match) leaks.push({ fixture: fixture.name, label, sample: match[0].slice(0, 80) })
    }
  }
  if (leaks.length === 0) {
    console.log('[corpus] redaction check: clean (' + captured.length + ' captured fixtures)')
    return true
  }
  console.error('[corpus] REDACTION LEAKS - refusing to write the corpus:')
  for (const leak of leaks.slice(0, 20)) {
    console.error('  ' + leak.fixture + '  [' + leak.label + ']  ' + leak.sample)
  }
  if (leaks.length > 20) console.error('  ... and ' + (leaks.length - 20) + ' more')
  return false
}

// ---------------------------------------------------------------------------
// Report and emit
// ---------------------------------------------------------------------------

function summarize() {
  const byFlag = { image: 0, json: 0, trace: 0, cjk: 0, mojibake: 0, repeated: 0 }
  let totalChars = 0
  let totalTokens = 0
  let imageChars = 0
  for (const fixture of fixtures) {
    totalChars += fixture.chars
    totalTokens += fixture.estimatedTokens
    if (fixture.image) imageChars += fixture.chars
    for (const flag of Object.keys(byFlag)) {
      if (fixture[flag]) byFlag[flag] += 1
    }
  }
  console.log('')
  console.log('[corpus] fixtures      : ' + fixtures.length)
  console.log('[corpus] total chars   : ' + totalChars)
  console.log('[corpus] est. tokens   : ' + totalTokens)
  for (const [flag, count] of Object.entries(byFlag)) {
    console.log('[corpus]   ' + flag.padEnd(9) + ': ' + count)
  }
  const aboveBalanced = fixtures.filter((fixture) => fixture.chars > 16000)
  console.log('[corpus]   over 16000 chars (balanced threshold): ' + aboveBalanced.length)
  if (imageChars > 0) {
    const share = ((100 * imageChars) / totalChars).toFixed(1)
    console.log('[corpus]   chars inside image-bearing fixtures: ' + imageChars + ' (' + share + '% of corpus)')
  }
}

function emit() {
  const target = path.join(repoRoot, 'tests', 'proxy', 'compression', 'fixtures.ts')
  fs.mkdirSync(path.dirname(target), { recursive: true })

  const header = [
    '/**',
    ' * Golden compression corpus - GENERATED, do not hand-edit.',
    ' *',
    ' * Regenerate:  node scripts/compress/extract-corpus.mjs',
    ' * Stats only:  node scripts/compress/extract-corpus.mjs --stats',
    ' *',
    ' * Extracted from real captured proxy payloads and redacted. The flags on',
    ' * each fixture mark the branch in `upstreamTokenOptimizer.ts` that it',
    ' * exercises, so a failure points at the rule that regressed rather than at',
    ' * a string diff.',
    ' */',
    "import type { CompressionFixture } from './types'",
    '',
    'export const FIXTURES: CompressionFixture[] = ',
  ].join('\n')

  const footer = [
    '',
    'export const FIXTURES_BY_NAME = new Map(',
    '  FIXTURES.map((fixture) => [fixture.name, fixture]),',
    ')',
    '',
  ].join('\n')

  fs.writeFileSync(
    target,
    header + JSON.stringify(fixtures, null, 2) + footer,
    'utf8',
  )
  const size = fs.statSync(target).size
  console.log('[corpus] wrote ' + path.relative(repoRoot, target)
    + ' (' + fixtures.length + ' fixtures, ' + Math.round(size / 1024) + ' KB)')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Importable for tests; only run the pipeline when invoked directly.
if (import.meta.main) {
  collectFromChatRequest('.testimg/req_real.json', 'reqreal')
  collectFromResponsesReplay('codex-replay-payload.json', 'replay')

  const sessionFile = 'codex-session-01a0cd8f-0e2c-7231-94dd-1f2778c16d7b.md'
  if (fs.existsSync(path.join(repoRoot, sessionFile))) {
    collectFromSessionMarkdown(sessionFile, 'session')
  }
  collectFromLogs('dev-data', 'log')
  addBoundaryFixtures()

  summarize()
  const raw = measureRawCapture()
  if (raw) {
    console.log('')
    console.log('[corpus] raw capture: ' + raw.file)
    console.log('[corpus]   tool outputs        : ' + raw.toolOutputs)
    console.log('[corpus]   with inline images  : ' + raw.imageOutputs
      + ' (' + ((100 * raw.imageOutputs) / raw.toolOutputs).toFixed(1) + '% of outputs)')
    console.log('[corpus]   est. tokens total   : ' + raw.totalTokens)
    console.log('[corpus]   est. tokens in images: ' + raw.imageTokens)
    console.log('[corpus]   IMAGE TOKEN SHARE   : ' + ((100 * raw.imageShare).toFixed(1)) + '%')
    console.log('[corpus]   (the redacted corpus above cannot show this; see measureRawCapture)')
  }
  const clean = verifyRedaction()
  if (statsOnly) {
    if (!clean) process.exitCode = 1
  } else if (clean) {
    emit()
  } else {
    console.error('[corpus] no file written')
    process.exitCode = 1
  }
}

// Re-exported for tests. `measureRawCapture`, `estimateTokens`, `hasImagePart`
// and the redact helpers are already declared with `export` above.
export {
  redact,
  redactPaths,
  redactSecrets,
  redactDataUrls,
  collapseWindowsPath,
  verifyRedaction,
  LEAK_PATTERNS,
  fixtures,
  repoRoot,
  path as repoPath,
}
