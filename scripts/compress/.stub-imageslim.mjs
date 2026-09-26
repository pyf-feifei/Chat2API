import { readFileSync, writeFileSync } from 'node:fs'

/**
 * One-shot: add the `../imageSlimPolicy` stub to every route test harness that
 * already stubs `../replayImageSlimming`. Each harness transpiles the route
 * module in isolation with its own `require`, so a new route import has to be
 * declared in all of them.
 */
const files = [
  'tests/server/qwen-ai-chat-tool-call-session.test.mjs',
  'tests/server/qwen-ai-responses-session-bridge.test.mjs',
  'tests/server/responses-effective-account.test.mjs',
]

for (const file of files) {
  const before = readFileSync(file, 'utf8')
  if (before.includes("'../imageSlimPolicy'")) {
    console.log(`skip ${file} (already stubbed)`)
    continue
  }

  // Find the replayImageSlimming stub block and append after its closing brace.
  const anchor = /(\s*)('\.\.\/replayImageSlimming':\s*\{[\s\S]*?\n\1\},)\n/
  const match = anchor.exec(before)
  if (!match) {
    console.error(`could not find the stub block in ${file}`)
    process.exitCode = 1
    continue
  }

  const indent = match[1]
  const stub = [
    `${indent}// Provider-neutral image slimming (Phase 2/4): the route asks the`,
    `${indent}// policy layer instead of the Qwen-only trigger, and the harness`,
    `${indent}// declines to slim so it keeps exercising the accounting path.`,
    `${indent}'../imageSlimPolicy': {`,
    `${indent}  resolveImageSlimPolicy: () => undefined,`,
    `${indent}  imageSlimModeFromEnv: () => 'off',`,
    `${indent}},`,
  ].join('\n')

  writeFileSync(file, before.replace(anchor, `${match[1]}\n${stub}\n`))
  console.log(`patched ${file}`)
}
