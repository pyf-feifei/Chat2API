# Qwen AI

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen-ai |
| 官网 | https://chat.qwen.ai |
| API Base | https://chat.qwen.ai |
| 认证 | JWT Token |
| 凭据字段 | `token`, `cookies` |

## 默认模型

下表是内置离线兜底列表；实际列表还会合并官网 `/api/v2/models/` 返回的模型。桌面和服务端启动时同步，代理运行期间每 5 分钟自动刷新；失败保留上次成功结果，后台刷新不阻塞对话。`CHAT2API_MODEL_CATALOGUE_REFRESH_INTERVAL_MS` 可调整间隔（毫秒，`0` 关闭定时刷新）；供应商管理中的更新模型按钮仍可手动刷新。

2026-11-11 实测接口已返回 `Qwen4-Max-Preview` → `qwen4.0-max-preview`，支持 1,000,000 上下文、131,072 摘要生成长度，`think_skip.enable=false`（思考不可跳过）。动态模型及能力会进入服务模型列表，无需手写内置模型；不会把已有 `Qwen3.8-Max` 请求擅自切到 Qwen4。

`Qwen3.8-Max` 映射到 `qwen3.8-max`，无 effort 时默认 Auto；客户端明确选择 Preview 才使用该 Preview 模型。

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.8-Max | qwen3.8-max |
| Qwen3.8-Max_Fast | qwen3.8-max |
| Qwen3.8-Max_Auto | qwen3.8-max |
| Qwen3.8-Max_Thinking | qwen3.8-max |
| Qwen3.7-Plus | qwen3.7-plus |
| Qwen3.7-Max | qwen3.7-max |

所有 Qwen 模型（显示名称和上游 ID）均支持大小写不敏感的 `_Fast`、`_Think`、`_Thinking`、`_Auto` 后缀。例如 `qwen4.0-max-preview_FAST`、`Qwen4-Max-Preview_think`、`Qwen3.7-Plus_auto`。后缀在请求上游前移除，分别发送 `thinking_mode: Fast / Thinking / Auto` 及相应布尔开关；动态目录为每个模型生成模式别名。

`_Fast` / `_Think` / `_Thinking` 固定模式并优先于客户端 effort，也不会被 `think_skip` 元数据静默覆盖；上游是否实际执行该模式仍由其响应决定，代理不隐藏或伪造思考输出。裸模型保留原有默认策略，`_Auto` 允许 `reasoning_effort` 决定模式。无 effort 时：

| 模型名 | thinking_enabled | auto_thinking |
| --- | --- | --- |
| Qwen3.8-Max | true | true |
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

## 浏览器验证条与风险会话恢复

`scripts/qwen-captcha/refresh.py` 区分三种页面控件：Baxia 的整条右拖验证条（`nc_*` / `.btn_slide`，包含 iframe）、拼图滑块（`aliyunCaptcha-*` 和 `puzzle-captcha-*` 两种 DOM，后者的裁剪拼图需要 CSS 纵坐标偏移）、图标连线。验证交互最多尝试 3 轮。浏览器应复用该账号自己的凭据，隔离上下文；现代 `access_token` 不写入 `token=` Cookie。

首次检测到验证信号即启动同账号 single-flight 恢复，浏览器任务全局串行；两次启动至少间隔 60 秒，同账号冷却期内的新挑战共享延迟恢复 Promise，等剩余冷却结束再认证，不再直接跳过恢复。当前请求重试前等待该恢复结束，并从 store 重新读取凭据，避免重放旧 Cookie。认证刷新被 WAF 暂停时先尝试同账号的浏览器恢复（有保存登录信息时可重新登录），失败才返回 HTTP 503 + `Retry-After`；已开始的 Responses 流将等待时间转换为 Codex 可识别的退避事件。密码重新登录会清除旧 `token=` Cookie，再合并本次登录响应，避免旧 Cookie 覆盖新 Bearer 凭据。创建会话在令牌刷新后仍返回 `Unauthorized` 时，会在同一请求内尝试浏览器重新认证再重试一次；认证仍未完成则返回 `qwen_ai_session_reauthentication_required` + HTTP 503 / `Retry-After`，而不是通用 `no chat ID returned`。

恢复成功必须满足：验证控件消失，并且同一浏览器内的新探测消息收到带随机标记的真实回复。仅拖动完成、采集到 Cookie 或已有历史回复，都不视为成功；上游认证返回 `success:false` 时立即停止，保持原凭据不变。需要年龄确认时只尝试关闭遮罩，不填写出生年份或提交账号设置。也会关闭已知的 Qwen 新版本介绍弹窗（例如 `Qwen4-Max is now in preview`）；欢迎、年龄与版本介绍可能先后出现，最多关闭 3 次，未知弹窗不自动点击。探针失败会记录布尔状态与计数（是否发送、是否仍有遮罩、认证是否被拒等），不记录页面正文、凭据或原始子进程 stderr。如果页面既未发送探针、也无活动挑战，即使没有捕获到认证拒绝响应，仍允许用已保存登录信息重新登录一次；已发送但无回复或挑战仍在时不触发该兜底。

- 桌面默认使用有窗口浏览器；Linux 无 `DISPLAY` 时请求 headless，但安装了 Xvfb 时优先启动独立虚拟显示、使用有窗口 Chromium，并在退出时回收显示进程。同账号对照中 headless 登录拼图连续被拒而 Xvfb 成功。`QWEN_CAPTCHA_XVFB=0` 可关闭该优先路径；`QWEN_CAPTCHA_HEADLESS=0` / `1` 控制基础浏览器模式。
- `CHROME_PATH` 指定浏览器；Windows 也会查找已安装的 Chrome。
- `QWEN_CAPTCHA_ARTIFACT_DIR` 指定诊断截图根目录，默认系统临时目录中的 `qwen-captcha`；服务为每次恢复创建独立 UUID 子目录，失败日志包含目录及白名单阶段名，异常关闭浏览器前保存 `failure.png`（截图可能包含会话内容，仅本地保留）。
- 登录页可能自动重定向到已登录首页，包括填写邮箱后的异步跳转。恢复脚本识别可见聊天输入框与本地 token，不再等待不存在的密码按钮；该判断仅跳过重复登录，仍需全新的随机标记回复才写回凭据。默认浏览器探针使用网页当前模型，基础会话恢复成功不代表指定 Qwen4 Fast 长工具请求已通过。
- 手动管理入口：`POST /v0/management/qwen-ai-governor/accounts/:accountId/refresh-risk-session`；可选 body `{ "punishUrl": "https://chat.qwen.ai/…" }`。只有验证成功才持久化凭据；此入口可能向其他账号传播新产生的非身份风险 Cookie，诊断时先用脚本单账号运行，不调用批量回写路径。

本地回归：`python tests/server/qwen-captcha-slider.test.py`（真实 Chrome、本地页面，无上游请求）；`node --test tests/server/qwen-ai-risk-refresh-verdict.test.mjs`（结果判定与持久化门控）。测试文件位于本地工作副本，按仓库约定不强制加入 Git。

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

RGV587 验证信封本身不能确定是否为 IP、账号会话或请求路径问题；先按上文做同账号、同模型对照，不把轮换账号或出口当作已验证的修复。Webshare 是可选且有界的恢复路径，不配置它不等于代理部署错误。启用后，`bxpunish`／RGV587 可触发出口重试，由 `CHAT2API_QWEN_AI_VERDICT_PROXY_EXIT_MAX` 限制尝试次数；已记录的相同请求会跳过该阶梯。普通流量默认直连，已验证恢复后可进入下述粘性模式。

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

managed tool calling 中，模型偶尔会在工具循环进行到一半时输出"叙事性"文本（说明它打算做什么）而不是工具调用（dangling answer）。代理会先在同一会话里发送 workflow continuation 提示要求它给出真正的工具调用；若续写分支本身仍是 dangling answer（同会话预算 `CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS` 默认 2 次已耗尽），或者续写遇到 `CHAT_IN_PROGRESS` 且恢复接口确认对应响应已结束／无数据帧，代理会升级为（死会话不再消耗剩余同会话续写次数）：

- 在**同一账号的全新 chat** 里重放完整干净请求（不带被拒绝的叙事分支历史），给模型一次无污染上下文的机会；
- 升级次数独立计数，每个逻辑请求默认 1 次，用环境变量调节：

```env
CHAT2API_QWEN_AI_SEMANTIC_FRESH_CHAT_ESCALATIONS=1
```

取值为 `0`（禁用升级，同会话预算耗尽即按 422 `qwen_ai_semantic_incomplete` 快速失败）、`1`（默认）或 `2`（上限）；其他值回退为 `1`。升级分支若再次 dangling，则快速失败并把 `retryable` 标志透传给客户端。wrapper 泄漏不适用此升级（泄漏是确定性违规，已有更紧的独立预算）。

## 服务内部恢复预算

Responses 请求（包括无工具的上下文压缩）在 Qwen 转发开始后立即建立 SSE，并持续发送 typed progress；恢复期间不要求客户端重连。每个逻辑请求共享浏览器验证预算，跨配额切换也不重置：`CHAT2API_QWEN_AI_SERVICE_RECOVERY_TIMEOUT_MS` 默认 300000，`CHAT2API_QWEN_AI_SERVICE_RECOVERY_BROWSER_ATTEMPTS` 默认 2（最多 4），`CHAT2API_QWEN_AI_SERVICE_RECOVERY_RETRY_DELAY_MS` 默认 60000。失败探针只按冷却重试验证，不盲目重发原长请求；仅同账号验证成功后重试原请求，且仍需实际生成通过。取消、超时、预算耗尽会结束请求，不扩大到全池轮换。已验证工具分支只交付一次，未通过的私有分支不交给客户端。普通文本流不因此整体缓冲。

## 浏览器恢复的验收范围

`QWEN_RECOVERY_PROBE_MODEL` 和 `QWEN_RECOVERY_PROBE_MODE` 可指定恢复探针模型与模式，例如 `qwen4.0-max-preview`／`Fast`。脚本通过网页现有选择控件切换，并核对带本次唯一标记的实际生成请求；所选模型或模式不符、没有真实新回复时，不接受凭据写回。留空仍使用浏览器默认模型，日志标记 `probeScope: browser-default-model`，不能据此证明其他模型恢复。

浏览器任务全局串行，同账号请求共享其自己的恢复 Promise，不以另一账号的恢复结果替代。只有恢复结果 ID 与当前账号一致时，才取消本次退避和清除对应恢复冷却。Responses 使用上节请求级服务恢复预算；其他调用方仍按原有 paced-retry 预算与请求截止时间等待已启动的同账号恢复，`CHAT2API_QWEN_AI_VERDICT_PACED_RETRIES=0` 可关闭其 paced 重试。验证成功才重试原请求，失败、取消或超时则不重放；服务预算跨账号共享，不因重入 forwarder 重置。状态 `active`、Cookie 收集成功、网页默认模型回复以及其他账号的成功，都不等于目标模型的当前请求可用。

`RGV587`／`bxpunish` 不直接证明封号、IP 封禁或内容拒绝。先核对凭据和身份，再用同账号、同模型、相近时间的短请求对照网页与 HTTP 路径。正常完成网站要求的验证后仍应复测真实生成，遵守配额与 Retry-After，不以连续轮换账号作为诊断或修复。

## 输入检查拒绝不是浏览器认证故障

上游显式 `data_inspection_failed` 按 HTTP 422、`retryable:false`、`accountFault:false` 透传，保留白名单 `input`／`output` 阶段，不恢复该 response id、不轮换账号重放。该类拒绝不携带通用 Retry-After，也不被 Responses 层改写成可重试的限流错误。否则关闭后的分支只返回 `The request is ended!`，会掩盖原始输入检查错误。浏览器普通问答和基础随机标记探针成功，不证明另一份长工具转录能通过上游检查；具体触发片段通常不在上游错误里。排查时固定单账号、模型、网络路径，并用成功的最小请求前后夹住对照；分别比较中性长文本、工具协议、内联与文件传输。基线若已遇 RGV587，该轮不用于内容归因。原文或文件哈希变化与结果变化的相关性，不等于已证明存在上游哈希黑名单；不要靠随机改写、换文件名或轮换账号宣称修复内容检查。

## Qwen4 Fast 工具通道兼容配置

2026-11-11 本地 Codex CLI 实测：保持客户端系统提示在原生字段、将 managed 工具提示留在 inline，并使用 `qwen_native` 文本协议后，两次真实 PowerShell 调用和最终答复完成，未发生客户端重连。首次请求仍经过内部恢复，不能视作低延迟或长期稳定性保证。原生 `function_call` 和 `qwen_native` 文本 `<function_calls>` 是不同通道，后者由代理解析后交客户端执行。

```env
CHAT2API_QWEN_AI_MANAGED_PROTOCOL=qwen_native
CHAT2API_QWEN_AI_SYSTEM_PROMPT_MODE=native
CHAT2API_QWEN_AI_TOOL_PROTOCOL_CHANNEL=inline
```

Compose 已暴露以上开关，修改 `.env` 后用 `docker compose up -d --no-build chat2api` 重建容器；普通 restart 不刷新环境。仓库默认保持 `qwen_hermes`／native／native，其他模型未据此统一迁移。此组合是请求通道兼容配置，不保证输入检查通过，也不通过更改正文绕过上游检查。

### Qwen4 工具路由对照与可回滚协议

`CHAT2API_QWEN_AI_MANAGED_PROTOCOL=qwen_bracket` 可选用 `[function_calls]`／`[call:name]{JSON}[/call]` 文本格式。保留工具别名、完整 schema 校验、完成标记和历史事实，仅改变代理到模型的工具序列化；未改变仓库默认协议。参数里的括号协议字样由 JSON 字符串边界隔离，坏调用批次不部分执行。

2026-11-12 对照：固定账号和 Fast 模型、前后精确 `ok` 基线下，XML 风格请求出现云端工具误选，方括号格式多次返回有效客户端调用。相同 XML 请求也会成功，因此这不是确定的词语触发结论。后续真实 Codex：干净会话两次本机调用完成，原约 307KB 长会话三次本机调用完成（目录、移位/比较命令、inflate 回归 10/10），均正常结束、无云端误调用及客户端重连。原长会话首轮仍有一次叙述型内部纠正，模型请求耗时约 28–56s；干净会话起始还遇配额/风控，不能据此宣称长期稳定或消除风控。

建议在实际客户端多步验收后选择此协议；回滚只需恢复 `.env` 中之前的协议值并重建本地容器。不要把生成出的工具文本当作已执行证据。

## Codex 本机执行工具的验收

当请求声明 `exec_command` 时，Qwen 的 `code_interpreter` 是云端沙箱，不是客户端本机：其结果不能证明本地文件操作已执行。代理将这种替代调用作为 `undeclared_native_tool_call` 走有界纠正；`web_extractor` 访问客户端 `file:` 或 loopback URL 也按同样规则处理，避免无效云端文件读取持续到 runaway 超时。普通计算／公网检索场景仍保留原来的上游内部工具处理。

工具转录所需的声明列表与别名表必须由 forwarder 通过请求的 `toolCallingPlan` 显式交给 adapter（首次、delta continuation 与恢复重放均一致），不能读取仅存在于响应处理器上的字段。原生工具片段使用 Qwen 的 `function_id` 区分独立调用，缺失时才回退到索引；否则多次云端调用可能共享一个片段状态。生成循环已有明确的工具语义错误时，watchdog 保留它，不覆盖成通用传输 502。

这类 executor 请求的纯文本最终答案必须附带协议 completion marker；口头计划不算执行完成。死会话 fresh-chat 重放会附上 tool-only 纠正指令，而非原样重复失败的请求。语义恢复只针对仍由流处理器保护的分支，不重复交付已执行工具。

### 参数完整性与续接阶段超时

`qwen_native` 参数以明确的 `</parameter>` 结束，不能在任意 `<` 处截断：命令可包含 `<<`、比较运算、HTML/XML。缺失关闭标签按 malformed 拒绝，不交付截断命令。历史格式化仍对 XML 做转义，解析后须保持原始参数值。

续接请求与首轮共享绝对请求截止时间，覆盖令牌续期、附件处理和 POST。另有 `CHAT2API_QWEN_AI_CONTINUATION_HEADERS_TIMEOUT_MS`（默认 60000）只约束等响应头；已接受的 SSE 不受此短计时器截断。超时报 `503 qwen_ai_continuation_headers_timeout`、account-neutral、`Retry-After: 30`；POST 是否接受不明时不在本层自动重发。日志 `continuation headers received/failed` 含 requestId、耗时和状态，不含正文与凭据。

语义纠正请求若遇每日配额、重新认证、输入检查或响应头超时，保留替代请求的真实错误并交给相应策略；不沿用之前的语义错误继续 fresh-chat 升级。

## 适配状态

已适配：国际版网页对话、流式对话、非流式对话、多轮会话、账号级清理对话记录、思考模式后缀、模型别名。

后续验证：官网反爬请求头、模型接口版本、Preview 邀请模型是否仍可用、图片/多模态模型字段。

## 教程

1. 登录 `chat.qwen.ai`。
2. 打开 DevTools -> Application -> Local Storage，复制 `token`；如请求需要 Cookie，同时复制完整 Cookie 字符串。
3. 在供应商管理中添加 Qwen AI 账号，填入 `token`，可选填 `cookies`。
4. 在模型管理中使用默认模型；如需上表其他模型，手动添加显示名称和实际模型 ID。
