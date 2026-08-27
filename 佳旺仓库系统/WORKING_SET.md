# WORKING_SET

## 当前阶段

M6 收尾验收（资源等级：重型 L）。主体实现已落地，当前只保留可验证的安全、回归、文档和交接工作。

## 当前活动

- 复核备份下载流/锁、恢复 journal containment 和数据库代际 fencing。
- 验证 pause/resume/retry 状态转换、Worker 协作式暂停和预算未知用量门槛。
- 复跑 typecheck、lint、测试、生产构建；记录 Node 24 SQLite binding 限制。
- 更新里程碑状态和部署/灾备 runbook，准备 reviewer 与 acceptance 报告。

## 已确认约束

- 生产 live SQLite、WAL、媒体和备份输出使用 Docker/WSL2 Linux named volume，不使用 OneDrive/SMB bind mount。
- API 使用 `/api/v1`、请求 ID、服务端 RBAC、Origin/CSRF；AI 只能写 suggestion/evidence，人工审核后才可发布/导出。
- 原图长期保留；第三方只接收去 EXIF 的派生压缩图；未知价格或 usage 不按 0 结算。
- 真实 DeepSeek 端点、视觉模型、价格和 HTTPS 证书由部署时提供，未提供前只能报告 mock/离线验证。

## 近期证据

构建、类型检查、Lint、平台自检、配置 smoke test 和离线测试已通过；完整测试中 2 项 SQLite 原生绑定相关用例在当前 Node 24 环境跳过。备份/恢复、权限和上传安全测试均有离线夹具覆盖。

## 下一步与停止条件

1. 接收 reviewer/acceptance 的逐项 PASS/FAIL/BLOCKED/NOT RUN 结果并修复关键问题。
2. 扫描敏感信息、核对 Git 状态和 compose 配置，建立首个安全提交。
3. 若再次遇到同一环境阻断且无新证据，停止重试并保留结构化 BLOCKED 记录，等待目标 Node 20/Docker/真实供应商配置。
