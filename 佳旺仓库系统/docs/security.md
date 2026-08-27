# 安全基线

- 密码使用 Argon2id（Node 原生实现不可用时回退到参数化 scrypt），数据库只保存编码后的哈希。密码修改必须验证当前密码，并会撤销该用户的全部会话后签发新会话。
- 会话使用随机 opaque token，`HttpOnly`、`Secure`（生产）、`SameSite=Lax` Cookie。所有状态变更 API 默认强制校验 `Origin` 和双提交 CSRF token；可选的本地自动化绕过必须显式设置 `REQUIRE_ORIGIN=false` / `REQUIRE_CSRF=false`。
- 解析 JSON 请求体的接口必须声明 `Content-Type: application/json`；上传分块等二进制接口使用明确的媒体类型并执行大小、路径和内容校验。
- 敏感动作（登录、登出、密码修改、账号/配置/类目变更、导入和审核操作、导出下载）写入审计日志。日志元数据会递归脱敏密码、token、Cookie、Authorization、API key 和原始路径。
- 服务端始终执行 RBAC；客户端隐藏按钮不构成授权。原始媒体只能经 RBAC 路由读取，响应带 `nosniff` 和安全的 `Content-Disposition`。
- DeepSeek 等外部端点必须通过 HTTPS 与 allowlist 校验，拒绝 URL 凭据和 SSRF；API key 仅从环境变量或加密配置读取，绝不写入响应、日志或备份清单。
