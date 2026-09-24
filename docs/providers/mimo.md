# Mimo

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | mimo |
| 官网 | https://aistudio.xiaomimimo.com |
| API Base | https://aistudio.xiaomimimo.com |
| 认证 | Cookie |
| 凭据字段 | `service_token`, `user_id`, `ph_token` |

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
| 自动刷新 | **不支持** — 参考项目 MiMo2API 同样无自动续期逻辑 |
| 过期症状 | 基础对话可能短暂可用，但多模态/识图等能力会静默失效；`/open-apis/user/mi/get` 校验会失败 |
| 过期修复 | 浏览器打开 `aistudio.xiaomimimo.com` → **退出登录**（不能只刷新页面）→ 重新登录 → 复制三枚新 Cookie → 更新账号凭据 |

OAuth 适配器的 `refreshToken()` 仅透传现有 Cookie，不会真正续期；请在账号失效后重新导入凭据。

## 教程

1. 登录 `aistudio.xiaomimimo.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `serviceToken`、`userId`、`xiaomichatbot_ph`。
3. 在供应商管理中添加 Mimo 账号并填写三项凭据。
4. 使用 `MiMo-V2.5-Pro` 作为首选验证模型。
5. 每约 24 小时检查账号状态；若 401/校验失败，按上文步骤重新登录并更新 Cookie。
