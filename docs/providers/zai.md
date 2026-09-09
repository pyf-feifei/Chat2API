# Z.ai

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | zai |
| 官网 | https://chat.z.ai |
| API Base | https://chat.z.ai/api |
| 认证 | JWT Token |
| 凭据字段 | `token`，可选 `captcha_verify_param` |
| 当前状态 | 受前端验证码风控限制，暂不可用 |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.1 | GLM-5.1 |
| GLM-5-Turbo | GLM-5-Turbo |
| GLM-5V-Turbo | GLM-5v-Turbo |
| GLM-5 | glm-5 |
| GLM-4.7 | glm-4.7 |

## 适配状态

暂不可用：Z.ai 当前对 `/api/v2/chat/completions` 增加了前端验证码风控校验。Web 页面可用是因为浏览器会运行阿里云 CaptchaJS、生成设备令牌并完成 VerifyCaptchaV3，再把短时有效的 `captcha_verify_param` 带入对话请求。代理侧仅携带 JWT token、Cookie、浏览器 headers 或 HAR 中复制出的旧 `captcha_verify_param`，仍可能返回 `FRONTEND_CAPTCHA_REQUIRED`。

已完成的适配尝试：流式对话、非流式对话、多轮会话、账号级清理对话记录、GLM 系列模型映射、`X-FE-Version: prod-fe-1.1.37`、`X-Region: domestic`、带浏览器环境 query 参数和 token 认证头的 `/api/v2/chat/completions` 请求。

后续方向：需要独立评估真实浏览器辅助模式，让 Z.ai Web 页面自行生成短时验证码参数；在此之前不建议把 Z.ai 作为稳定可用供应商。

## 搜索与思考深度

- 单轮搜索：请求体 `web_search: true`（或 `X-Web-Search: true` 头）映射为 z.ai 的 `features.auto_web_search`。
- 高级搜索（多轮研究）：请求体 `deep_research: true`（或 `X-Deep-Research: true` 头）同时开启搜索与思考，由 z.ai 服务端执行多轮检索分析。
- 思考深度：`reasoning_effort`（`low`/`medium`/`high`；`minimal`/`xhigh` 先归一化）映射为 z.ai Web 的 `features.reasoning_effort`（`low`/`high`/`max`）；未显式指定档位时默认 `max`；`reasoning_effort: false` 关闭深度思考。

## 超长会话传输

内联历史超出 `CHAT2API_ZAI_REQUEST_MAX_BYTES`（默认 `92160` 字节）时，代理将完整会话转录为 `context-<id>.txt` 文档上传，活跃轮仅保留指针句与 8KB 尾部摘录。`CHAT2API_ZAI_TRANSCRIPT_UPLOAD_ENABLED=false` 关闭该 offload、保持完整内联上下文；用户原始附件上传不受影响。

## 工具调用与多轮历史

- z.ai 上游以建会话时的种子消息作为模型上下文；代理把扁平化后的完整历史（含 managed XML 工具调用、工具结果与 workflow 续接提示）作为种子写入新建 chat，保证 tool result 回喂与多轮上下文可达上游。
- 流式/非流式工具拦截统一走 `ToolStreamParser(plan)`（与 GLM 一致），识别 managed 协议并防止包装泄漏。

## 教程

1. 登录 `chat.z.ai`。
2. 打开 DevTools -> Application -> Cookies 或请求头，复制以 `eyJ` 开头的 JWT token。
3. 在供应商管理中添加 Z.ai 账号，填入 `token`。
4. 当前对话接口受验证码风控限制，添加账号不代表可正常完成对话。
5. `captcha_verify_param` 仅保留为调试字段；该值通常短时有效，不能作为长期账号凭据使用。
