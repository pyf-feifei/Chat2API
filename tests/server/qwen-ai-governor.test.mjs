import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Qwen AI requests are routed through a per-provider governor', () => {
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(forwarderSource, /qwenAiRequestGovernor/)
  assert.match(forwarderSource, /qwenAiRequestGovernor\.run\(account\.id/)
  assert.match(forwarderSource, /this\.forwardQwenAi\(request, account, provider, actualModel, startTime\)/)

  assert.match(governorSource, /CHAT2API_QWEN_AI_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD/)
  assert.match(governorSource, /maxConcurrent/)
  assert.match(governorSource, /accountNextAvailableAt/)
  assert.match(governorSource, /attachRelease\(result\.stream, release\)/)
})

test('Qwen AI risk-control failures cool the account and require distinct accounts before global circuit', () => {
  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(chatRouteSource, /isQwenAiRiskControl/)
  assert.match(chatRouteSource, /FAIL_SYS_USER_VALIDATE\|RGV587/)
  assert.match(chatRouteSource, /loadBalancer\.markQwenAiRiskControl\(account\.id\)/)

  assert.match(loadBalancerSource, /markAccountCooldown/)
  assert.match(loadBalancerSource, /markQwenAiRiskControl/)
  assert.match(loadBalancerSource, /QWEN_AI_RISK_COOLDOWN/)
  assert.match(loadBalancerSource, /cooldownUntil/)
  assert.match(loadBalancerSource, /isAccountInHardCooldown/)
  assert.match(loadBalancerSource, /filter\(account => !this\.isAccountInHardCooldown\(account\.id\)\)/)

  assert.match(governorSource, /qwen_ai_risk_control/)
  assert.match(governorSource, /2 \*\* \(failures - 1\)/)
  assert.match(governorSource, /recordGlobalRiskControl/)
  assert.match(governorSource, /recordGlobalRiskControl\(accountId, config\)/)
  assert.match(governorSource, /new Set\(this\.riskEvents\.map\(event => event\.accountId\)\)\.size/)
  assert.match(governorSource, /qwen_ai_global_risk_circuit/)
  assert.match(governorSource, /createGlobalCircuitOpenResult/)
  assert.match(governorSource, /Retry-After/)
  assert.match(chatRouteSource, /ctx\.set\(key, value\)/)
})

test('Qwen AI governor exposes configurable global risk circuit settings', () => {
  const sharedTypes = fs.readFileSync('src/shared/types.ts', 'utf8')
  const storeTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const configSource = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  const zh = fs.readFileSync('src/renderer/src/i18n/locales/zh-CN.json', 'utf8')

  for (const source of [sharedTypes, storeTypes, panelSource]) {
    assert.match(source, /globalRiskCooldownMs/)
    assert.match(source, /maxGlobalRiskCooldownMs/)
    assert.match(source, /riskWindowMs/)
    assert.match(source, /globalRiskThreshold/)
  }

  assert.match(sharedTypes, /globalCooldownInMs/)
  assert.match(sharedTypes, /recentRiskEvents/)
  assert.match(sharedTypes, /recentRiskAccounts/)
  assert.match(storeTypes, /globalMinIntervalMs:\s*15000/)
  assert.match(storeTypes, /accountMinIntervalMs:\s*120000/)
  assert.match(storeTypes, /globalRiskCooldownMs:\s*30 \* 60 \* 1000/)
  assert.match(storeTypes, /globalRiskThreshold:\s*3/)
  assert.match(configSource, /maxGlobalRiskCooldownMs must be greater than or equal to globalRiskCooldownMs/)
  assert.match(zh, /全局风控熔断/)
})

test('Qwen AI governor auto-tunes effective rate limits from healthy accounts and risk events', () => {
  const sharedTypes = fs.readFileSync('src/shared/types.ts', 'utf8')
  const storeTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const configSource = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  const en = fs.readFileSync('src/renderer/src/i18n/locales/en-US.json', 'utf8')

  for (const source of [sharedTypes, storeTypes]) {
    assert.match(source, /autoTuneEnabled/)
    assert.match(source, /autoTuneMaxConcurrent/)
    assert.match(source, /autoTuneMinGlobalIntervalMs/)
  }

  assert.match(sharedTypes, /QwenAiGovernorEffectiveConfig/)
  assert.match(sharedTypes, /effectiveConfig: QwenAiGovernorEffectiveConfig/)
  assert.match(storeTypes, /autoTuneEnabled:\s*true/)
  assert.match(storeTypes, /autoTuneMaxConcurrent:\s*2/)
  assert.match(storeTypes, /autoTuneMinGlobalIntervalMs:\s*8000/)
  assert.match(configSource, /qwenAiGovernorConfig\.autoTuneEnabled must be a boolean/)
  assert.match(governorSource, /calculateEffectiveConfig/)
  assert.match(governorSource, /healthyAccountCount >= 4/)
  assert.match(governorSource, /recent_risk_events/)
  assert.match(governorSource, /single_or_no_healthy_account/)
  assert.match(governorSource, /effectiveConfig/)
  assert.match(panelSource, /qwen-auto-tune/)
  assert.match(panelSource, /status\?\.effectiveConfig\.maxConcurrent/)
  assert.match(panelSource, /autoTuneMaxConcurrent/)
  assert.match(en, /Auto tuning/)
})
