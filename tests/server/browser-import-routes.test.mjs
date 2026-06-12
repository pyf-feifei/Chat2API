import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('management API exposes browser-assisted import completion route', () => {
  const source = fs.readFileSync('src/main/proxy/routes/management/statistics.ts', 'utf8')

  assert.match(source, /router\.post\('\/browser-import\/complete'/)
  assert.match(source, /router\.get\('\/browser-import\/:importId'/)
  assert.match(source, /providerId/)
  assert.match(source, /importId/)
  assert.match(source, /credentials/)
  assert.match(source, /qwen-ai/)
  assert.match(source, /tongyi_sso_ticket/)
  assert.match(source, /setBrowserImportResult/)
})

test('web admin browser import session store has bounded ttl', () => {
  const source = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')

  assert.match(source, /BROWSER_IMPORT_SESSION_TTL_MS/)
  assert.match(source, /10 \* 60 \* 1000/)
  assert.match(source, /cleanupBrowserImportSessions/)
  assert.match(source, /function createBrowserImportId/)
  assert.match(source, /globalThis\.crypto\?\.randomUUID/)
  assert.match(source, /getRandomValues/)
  assert.doesNotMatch(source, /const id = crypto\.randomUUID\(\)/)
})

test('browser-assisted import has bounded result storage and local-network cors support', () => {
  const routeSource = fs.readFileSync('src/main/proxy/routes/management/statistics.ts', 'utf8')
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')

  assert.match(routeSource, /BROWSER_IMPORT_RESULT_LIMIT/)
  assert.match(routeSource, /browserImportResults\.delete/)
  assert.match(serverSource, /Access-Control-Allow-Private-Network/)
})

test('browser-assisted import accepts text/plain JSON from provider pages and reports HTTP failures', () => {
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')
  const webAdminSource = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')

  assert.match(
    serverSource,
    /enableTypes:\s*\[[^\]]*'json'[^\]]*'form'[^\]]*'text'[^\]]*\]/,
    'koa-bodyparser must parse text/plain JSON sent from provider pages',
  )
  assert.match(webAdminSource, /if \(!response\.ok\)/)
  assert.match(webAdminSource, /throw new Error\(\\`Chat2API browser import failed/)
  assert.match(webAdminSource, /Chat2API browser import sent/)
})
