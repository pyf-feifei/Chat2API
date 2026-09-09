# Qwen AI

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen-ai |
| 官网 | https://chat.qwen.ai |
| API Base | https://chat.qwen.ai |
| 认证 | JWT Token |
| 凭据字段 | `token`, `cookies` |

## 默认模型

内置默认模型使用当前 Qwen AI 官方模型清单。`Qwen3.8-Max` 会映射到 `qwen3.8-max`，默认使用 Thinking 模式：`thinking_enabled: true`、`auto_thinking: false`；Preview 模型仅在客户端明确选择对应名称时使用。

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.8-Max | qwen3.8-max |
| Qwen3.8-Max_Fast | qwen3.8-max |
| Qwen3.8-Max_Auto | qwen3.8-max |
| Qwen3.8-Max_Thinking | qwen3.8-max |
| Qwen3.7-Plus | qwen3.7-plus |
| Qwen3.7-Max | qwen3.7-max |

`Qwen3.8-Max` 模式名称会优先于客户端传入的 `reasoning_effort` / `enable_thinking`：

| 模型名 | thinking_enabled | auto_thinking |
| --- | --- | --- |
| Qwen3.8-Max | true | false |
| Qwen3.8-Max_Fast | false | false |
| Qwen3.8-Max_Auto | true | true |
| Qwen3.8-Max_Thinking | true | false |

也支持原始控制形式 `Qwen3.8-Max_TeT_AtT`。`Te` 后的 `T` / `F` 控制 `thinking_enabled`，`At` 后的 `T` / `F` 控制 `auto_thinking`，例如 `Qwen3.8-Max_TeF_AtT` 会发送 `false / true`。旧的 `-fast` 和 `-thinking` 后缀仍可使用。

## 其他官网模型

以下模型来自 `backup/har/chat.qwen.ai2.har` 中实际调用对话的官网模型。它们不作为内置默认模型，用户可在供应商管理 -> 模型管理中自行添加：显示名称填左列，实际模型 ID 填右列。

| 显示名称 | 实际模型 ID | 备注 |
| --- | --- | --- |
| Qwen3.7-Max-Preview | qwen-latest-series-invite-beta-v24 | Preview |
| Qwen3.7-Plus-Preview | qwen-latest-series-invite-beta-v16 | Preview |
| Qwen3.6-Max-Preview | qwen3.6-max-preview | Preview |
| Qwen3.6-Plus-Preview | qwen3.6-plus-preview | Preview |
| Qwen3.5-Plus | qwen3.5-plus | 低版本 |
| Qwen3.5-Omni-Plus | qwen3.5-omni-plus | 低版本 |
| Qwen3.5-Flash | qwen3.5-flash | 低版本 |
| Qwen3.5-Max-Preview | qwen3.5-max-2026-03-08 | 低版本 Preview |
| Qwen3.5-397B-A17B | qwen3.5-397b-a17b | 低版本 |
| Qwen3.5-122B-A10B | qwen3.5-122b-a10b | 低版本 |
| Qwen3.5-Omni-Flash | qwen3.5-omni-flash | 低版本 |
| Qwen3.5-27B | qwen3.5-27b | 低版本 |
| Qwen3.5-35B-A3B | qwen3.5-35b-a3b | 低版本 |
| Qwen3-Max | qwen3-max-2026-01-23 | 普通 Qwen3 |
| Qwen3-235B-A22B-2507 / Qwen2.5-Plus | qwen-plus-2025-07-28 | HAR 页面标签存在歧义 |
| Qwen3-VL-235B-A22B | qwen3-vl-plus | 多模态 |
| Qwen3-Omni-Flash | qwen3-omni-flash-2025-12-01 | Omni |
| Qwen2.5-Max | qwen-max-latest | 低版本 |

## 超长会话传输

超出 `CHAT2API_QWEN_AI_REQUEST_MAX_BYTES`（默认 `92160` 字节）的会话默认会把 Chat2API 生成的完整 transcript 作为文件上传，以减小 Qwen completion 请求体。可在 Docker 环境中配置：

```env
CHAT2API_QWEN_AI_TRANSCRIPT_UPLOAD_ENABLED=true
CHAT2API_QWEN_AI_TRANSCRIPT_EXTENSION=txt
```

`CHAT2API_QWEN_AI_TRANSCRIPT_EXTENSION` 支持 `txt`（默认，MIME 为 `text/plain`）或 `md`（MIME 为 `text/markdown`）。`CHAT2API_QWEN_AI_TRANSCRIPT_UPLOAD_ENABLED=false` 会关闭 Chat2API 生成的 transcript 文件上传，强制把完整会话直接放在文本请求中；这不会关闭用户原始图片、音频、视频或其他附件的上传。关闭上传后，请求体可能超过 offload target，并受 Qwen 自身的请求体和上下文限制影响。`.md` 的服务端解析行为可能与 `.txt` 不同，遇到兼容性问题时建议恢复使用 `txt`。

## 管理工具结果包装泄漏恢复

个别模型（尤其在长思考的 managed tool calling 会话中）会把 Chat2API 的内部 tool-result 包装语法复述进 assistant 输出。代理会在 delta 级检测并剥离这些泄漏文本，并按如下策略恢复：

- 泄漏一旦确认（字面协议违规，不会被后续输出撤销），立即替换当前生成分支，而不是等 provider 终端标记——单次尝试从数分钟降到一次重放的耗时。
- 替换分支若再次泄漏，则快速失败（422 `qwen_ai_wrapper_leak`，`retryable:false` 一并透传给客户端），避免慢速重放循环耗尽整个恢复预算。
- 每个逻辑请求的泄漏重放次数可用环境变量调节：

```env
CHAT2API_QWEN_AI_WRAPPER_LEAK_RECOVERY_ATTEMPTS=1
```

取值为 `0`（禁用泄漏重放，检测即失败）、`1`（默认）或 `2`（上限）；其他值回退为 `1`。

## 内容决定型失败的账号轮换上限与 busy 风暴治理

内容决定型 422 失败（dangling answer、wrapper 泄漏、工具调用参数违规等）由**请求内容**决定，不随账号变化——2026-09-07 的线上事故中，同一个 49K-token 请求在 5 个不同账号上全部 422 `qwen_ai_semantic_incomplete`，轮换只是重复烧账号。两个治理机制：

**账号轮换上限**：当同一逻辑请求的当前失败与全部历史均为内容决定型失败时停止轮换，把终态 422 交给客户端（`retryable:false` 已透传，客户端会调整策略而不是盲目重放）。状态化路由（chat/responses）的共享重放预算本来就把轮换限到一次，此规则把同一保证扩展到 anthropic 路由（未线程化恢复状态）与未来回归。默认 `0` 表示只允许一次共享重放（2 个账号）；模型行为存在账号相关性（另一账号的私有分支可能成功），需要更宽的部署可调高：

```env
CHAT2API_QWEN_AI_CONTENT_FAILOVER_ROTATION_MAX=0
```

取值为 `0`（默认，2 个账号封顶）、`1`（3 个账号封顶）等；`off` 禁用上限。计数语义与 busy 停止规则一致（上限 N = 至多 N+1 次轮换）。混合历史（busy → semantic 等）不触发——容量失败仍按自己的预算轮换。

**busy 风暴治理**：RGV587 风控页会伪装成容量 busy（验证信封 + "被挤爆"文案同时出现，被归类为 `qwen_ai_upstream_busy`，账号中立），单账号闪断由同账号 busy 重试（`CHAT2API_QWEN_AI_BUSY_RETRY_COUNT`）处理；但当**同一逻辑请求内 ≥N 个不同账号**全部 busy 时即为风暴（IP 级风控或真过载），此时上报 governor：风暴链上的每个账号进入有界冷却（凭证保持健康，到期自动恢复），事件汇入既有的全局风控熔断与半开探活——后续客户端重连会收到 429 `qwen_ai_global_risk_circuit` 或带 `Retry-After` 的终态响应而主动退避，而不是每条重连都全量重放 49K-token 内容去敲打风控闸门：

```env
CHAT2API_QWEN_AI_BUSY_STORM_ACCOUNT_THRESHOLD=2
CHAT2API_QWEN_AI_BUSY_STORM_COOLDOWN_MS=600000
```

阈值取 `1` 即"任何停止点上的 busy 都上报"；冷却下限不低于账号节奏间隔。真实容量事件被误判时，全局熔断的半开探活会在节奏间隔后放行一个请求、首个成功即关闭熔断，分钟级自愈。阈值应 ≤ busy 轮换上限 + 1（默认 2 ≤ 3），保证风暴在停止点或之前必被上报；两者为独立旋钮，部署可自行调整但不应打破该耦合。


## RGV587 风控的 Webshare 代理重试（可选）

RGV587 是 IP 级风控：验证信封标记的是出口 IP，轮换账号只会让所有账号继续从同一个被标记的出口撞上风控墙。配置 Webshare 代理后，当请求被归类为 `qwen_ai_upstream_busy`（RGV587 伪装成容量 busy）且同账号 busy 重试预算（`CHAT2API_QWEN_AI_BUSY_RETRY_COUNT`，默认 0）耗尽时，代理会通过 Webshare 出口 IP 把同一请求再重试一次（每个逻辑请求最多 1 次）；平时所有流量仍走直连，只有这条恢复路径使用代理，流量消耗保持最低。

两条触发路径都会用代理（各最多 1 次）：busy 重试预算耗尽后的恢复重试，以及文档管线失败逃生重试（见下节）。

### 管理页面配置（推荐）

管理页 → 代理设置 → **Webshare Proxy** 标签页可直接配置代理 URL 与启用开关：保存即持久化并**运行时立即生效**（无需重启容器），状态徽章显示当前生效配置与来源。持久化配置优先于环境变量；点"清除"回到纯环境变量模式。

除单 URL 外，标签页还支持 **key 池**（每个 key = 一个独立出口 IP）：添加多个 Webshare key 后选择轮换策略（round-robin 逐个轮换 / failover 固定主 key、坏了自动切下一个、冷却过期自动切回 / random 随机）。某个出口失败会进入冷却（60s 起，连续失败翻倍，上限 30 分钟），流量自动切到下一个 key；成功即清零冷却。池优先于单 URL。

Webshare API Keys：管理页可存储 Webshare 官网 API Key；保存后后端自动拉取每个 key 的 Proxy List 并把全部出口并入轮换池（条目打 sourceKeyId 标），默认每 30 分钟自动同步（可配 5..1440 分钟，也可「立即同步」手动触发）；合并按代理 URL 匹配，保留冷却/失败/启停与手动条目的运行时状态；key 列表中消失的出口在下次成功同步时移除，拉取失败的 key 保留最后已知出口。

### 粘性切换（模式 B）

单次逃生（上文默认行为）每个请求都要先撞一次直连风控再走代理；粘性模式消除这笔重复税：当某次恢复重试**经代理成功**（证明直连出口 IP 被风控而代理出口正常），代理进入粘性状态——**所有** Qwen 流量常驻走 Webshare 出口（池内继续按策略轮换），同时后台每 60 秒对 `www.qwen.ai` 发一次直连探测（不带账号、不占请求路径）：

- 探测响应仍带 RGV587/风控标记 → 保持粘性；连续干净探测达到 2 次 → 自动切回直连（防风控抖动误判）；
- 探测超时/网络故障 → 视为不可判定，保持粘性（切回过早代价是请求失败，多走一会代理只花带宽）；
- 代理出口本身传输层失败（隧道断开等）→ 立即解除粘性并改走直连重试，不会卡死在坏代理后面。

管理页状态徽章区会显示粘性横幅（进入原因、已通过探测次数、下次探测时间），并可手动"立即切回直连"（`POST /v0/management/webshare-proxy/sticky/disengage`）。

### 环境变量配置

```env
WEBSHARE_PROXY_ENABLED=true
WEBSHARE_PROXY_URL=http://user:pass@proxy.webshare.io:8080
```

也接受 `CHAT2API_` 前缀的等价变量（`CHAT2API_WEBSHARE_PROXY_ENABLED` / `CHAT2API_WEBSHARE_PROXY_URL`，前缀版优先）。未配置代理或开关不为 `true`/`1` 时，行为与之前完全一致（busy 风暴治理照常生效）。

## 文档管线失败的 inline 逃生

`qwen_hermes` 托管协议会把超长会话转录上传为文档（`CHAT2API_QWEN_AI_TRANSCRIPT_UPLOAD_ENABLED`）。文档管线（上传/解析）整体性故障时（2026-09-07/08 实测：同一转录在 6 个账号上全部 parse 超时 120s，而 inline 通道同窗口 12 秒正常完成），换账号无意义——失败由管线而非账号决定。

发生 `qwen_ai_file_parse_timeout` 等文档管线失败时，代理会在**同一账号**上以 inline 传输重试一次（`messageTransportLocked`，跳过字节 offload，不再重入死掉的文档管线）；若此时 Webshare 代理已配置且该请求尚未用过代理，这次逃生重试会经代理出口 IP 发出（IP 级故障时 inline 直连同样可能被风控）。逃生重试每个逻辑请求最多 1 次。

## 同会话语义续写耗尽后的全新会话升级

managed tool calling 中，模型偶尔会在工具循环进行到一半时输出"叙事性"文本（说明它打算做什么）而不是工具调用（dangling answer）。代理会先在同一会话里发送 workflow continuation 提示要求它给出真正的工具调用；若续写分支本身仍是 dangling answer（同会话预算 `CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS` 默认 1 次已耗尽），代理会升级为：

- 在**同一账号的全新 chat** 里重放完整干净请求（不带被拒绝的叙事分支历史），给模型一次无污染上下文的机会；
- 升级次数独立计数，每个逻辑请求默认 1 次，用环境变量调节：

```env
CHAT2API_QWEN_AI_SEMANTIC_FRESH_CHAT_ESCALATIONS=1
```

取值为 `0`（禁用升级，同会话预算耗尽即按 422 `qwen_ai_semantic_incomplete` 快速失败）、`1`（默认）或 `2`（上限）；其他值回退为 `1`。升级分支若再次 dangling，则快速失败并把 `retryable` 标志透传给客户端。wrapper 泄漏不适用此升级（泄漏是确定性违规，已有更紧的独立预算）。

## 适配状态

已适配：国际版网页对话、流式对话、非流式对话、多轮会话、账号级清理对话记录、思考模式后缀、模型别名。

后续验证：官网反爬请求头、模型接口版本、Preview 邀请模型是否仍可用、图片/多模态模型字段。

## 教程

1. 登录 `chat.qwen.ai`。
2. 打开 DevTools -> Application -> Local Storage，复制 `token`；如请求需要 Cookie，同时复制完整 Cookie 字符串。
3. 在供应商管理中添加 Qwen AI 账号，填入 `token`，可选填 `cookies`。
4. 在模型管理中使用默认模型；如需上表其他模型，手动添加显示名称和实际模型 ID。
