# Mimo

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | mimo |
| 官网 | https://aistudio.xiaomimimo.com |
| API Base | https://aistudio.xiaomimimo.com |
| 认证 | Cookie |
| 凭据字段 | `service_token`, `user_id`, `ph_token`（可选 `email`, `password` 用于自动续期） |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| MiMo-V2.5-Pro | mimo-v2.5-pro |
| MiMo-V2.5 | mimo-v2.5 |
| MiMo-V2-Flash | mimo-v2-flash |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、会话保存、标题生成、账号级清理对话记录、托管工具调用。

后续验证：官网 Cookie 字段、会话保存接口、模型 ID 升级。

## Token 有效期与过期处理

Mimo 使用 Cookie 认证（`serviceToken` / `userId` / `xiaomichatbot_ph`），**没有官方 refresh token 接口**。

| 项 | 说明 |
| --- | --- |
| `serviceToken` 有效期 | 约 **24 小时** |
| 官方 refresh 接口 | **无** — 只能重新登录换发 |
| 账号密码自动刷新 | **支持（可选）** — 在账号上填写小米邮箱 + 密码后，401/403 时先走 `account.xiaomi.com` passport（`serviceLoginAuth2`）；若被风控（`70016` / 验证码），默认 `MIMO_REFRESH_MODE=auto` 回落 `scripts/mimo-login/login.py`（真实 Chrome + Geetest 滑块 + 邮箱 OTP） |
| 过期症状 | 基础对话可能短暂可用，但多模态/识图等能力会静默失效；`/open-apis/user/mi/get` 校验会失败 |
| 过期修复（无密码） | 浏览器打开 `aistudio.xiaomimimo.com` → **退出登录**（不能只刷新页面）→ 重新登录 → 复制三枚新 Cookie → 更新账号凭据 |
| 风控/验证码 | 小米可能返回 `70016`、`captchaUrl` 或身份核验跳转；此类失败按可重试处理，不冻结账号，并自动改走浏览器登录 |

OAuth 适配器的 `refreshToken()` 仅透传现有 Cookie（管理 API 用）；真正的续期由 `mimo-token-refresh.ts` 在聊天 401 时触发。

## 教程

1. 登录 `aistudio.xiaomimimo.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `serviceToken`、`userId`、`xiaomichatbot_ph`。
3. 在供应商管理中添加 Mimo 账号并填写三项凭据。
4. （推荐）同时填写小米账号 **登录邮箱** 与 **密码**，serviceToken 过期后可自动重新登录刷新。
5. 使用 `MiMo-V2.5-Pro` 作为首选验证模型。
6. 每约 24 小时检查账号状态；若 401 且未配置邮箱密码，按上文步骤重新登录并更新 Cookie。

## Docker 控制台导入

Docker Web 管理端在「OAuth 登录」标签页可生成控制台脚本：在已登录的 `aistudio.xiaomimimo.com` 页面 DevTools Console 粘贴执行，脚本读取 Cookie 后回传；若 Cookie 为 HttpOnly 读不到，可将 payload 手动粘贴回管理页，或改用手动输入。

## 浏览器脚本登录并导入（数据中心 IP / 风控）

`serviceLoginAuth2` 在数据中心 IP 上常返回 `70016`。可用真实 Chrome 走官方登录页，人工改密码或过验证后自动导入：

```bash
python scripts/mimo-login/login.py \
  --email 'you@example.com' \
  --password 'your-password' \
  --allow-human \
  --human-timeout 420
```

要点：

- 默认导入到管理 API `http://127.0.0.1:8080`，密钥取 `CHAT2API_MANAGEMENT_SECRET`（缺省 `admin123`）。
- 按邮箱匹配已有 mimo 账号；没有则自动 `POST /v0/management/accounts` 创建。
- `PUT` 会合并写入 `service_token` / `user_id` / `ph_token` / `email` / `password`。
- 密码被拒或出现验证时不会直接退出：`--allow-human` 下浏览器保持打开，人工修正后脚本继续收割 Cookie 并导入。
- 若触发「小米账号安全验证」：脚本会自动点「发送邮件」并自动取码填入；也可人工在浏览器输入，或先取码后加 `--email-code <code>`。
- 仅想拿 Cookie 不写库时加 `--no-import`；已有账号可加 `--account-id <id>`。

### 401 自动刷新如何选择 HTTP / 浏览器

聊天 401/403 触发 `mimo-token-refresh.ts` 时：

| `MIMO_REFRESH_MODE` | 行为 |
| --- | --- |
| `auto`（默认） | 先 HTTP `serviceLoginAuth2`；撞风控/验证码（非账号故障）时回落 `login.py`（`--no-import --headless`，Cookie 由 `storeManager` 写回） |
| `http` | 只走 passport HTTP，不启浏览器 |
| `browser` | 跳过 HTTP，直接滑块+OTP 登录 |

相关环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MIMO_LOGIN_SCRIPT_PATH` | 自动探测 `scripts/mimo-login/login.py` | 脚本绝对路径覆盖 |
| `MIMO_PYTHON_PATH` | PATH 探测（优先带 patchright） | Python 解释器 |
| `MIMO_REFRESH_BROWSER_TIMEOUT_MS` | `300000` | 浏览器子进程总超时 |
| `MIMO_REFRESH_BROWSER_WAIT_SECONDS` | `90` | 传给 `login.py --wait-seconds` |
| `MIMO_REFRESH_BROWSER_HUMAN` | 关 | `1` 时改 `--allow-human` 可视窗口 |
| `MIMO_REFRESH_BROWSER_GMAIL` | 开 | `0` 时 `--no-gmail-code` |
| `MIMO_GMAIL_HELPER` | UI/内置 helper | OTP 取码脚本 |

`login.py` 成功时 stdout 输出一行 JSON（`kind=ok` + 三 Cookie）；刷新路径使用 `--no-import`，因此不会二次 PUT 管理 API。

### 登录入口

脚本优先从 MiMo 应用首页进入登录（与 skill 一致），而不是直连 passport：

1. 打开 `https://aistudio.xiaomimimo.com/#/c`，点击 **Sign in**。
2. 兜底 `https://account.xiaomi.com/fe/service/login/password?_locale=en_US`。
3. Cookie 不齐时回 `#/c` 再点 Sign in（`ensure_mimo_cookies`）。

成功判定只认三枚 Cookie 齐全：`service_token` + `user_id` + `ph_token`。OTP 后落到 `account.xiaomi.com/fe/service/account?cUserId=...` 视为已登录。

### Gmail 自动取码

安全验证码邮件可通过 Maton Gmail 连接自动读取，无需人工抄码：

1. 在 `/admin/#/settings` → **Gmail** 配置 Maton API Key、Connection ID（及可选 gateway/control base URL），保存并点「测试连接」。
2. 运行登录脚本时优先走管理端点 `POST /v0/management/gmail/code`；服务未配置时回落本地 helper（`$CODEX_HOME/skills/gmail/scripts/maton_gmail.py`，或用 env `MIMO_GMAIL_HELPER` 指定）。
3. 也可手动传 `--email-code <6位码>` 跳过自动取码。

管理端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v0/management/gmail/config` | 读取配置（key 脱敏为 `***`） |
| POST | `/v0/management/gmail/test` | 测试 Maton 连接 |
| POST | `/v0/management/gmail/code` | body `{ email, sinceMs }`，返回最新验证码 |

Maton 默认：`gateway=https://gateway.maton.ai/google-mail`，`control=https://ctrl.maton.ai`。
