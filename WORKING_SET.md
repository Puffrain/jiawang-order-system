# Working Set

## 2026-08-28 发布安全修复

- 资源等级：重型。当前分支 `fix/release-safety-readme`，生产保持不变。
- GitHub 仓库 `Puffrain/jiawang-order-system` 已公开，采用 MIT License；`main` 已启用 `verify`、一次审批、管理员强制、线性历史、禁止强推和删除。
- `baseline-v1` 指向已通过 GitHub CI 的 `3ff147b`；当前修复尚未合并或标记新版本。
- 隔离预览曾在 `http://127.0.0.1:3113` 完成人工商品录入、审核、发布、订单与媒体同步、备份恢复和浏览器验收。
- 独立 reviewer 返回 REVIEW FAIL：数据库迁移后自动切回旧镜像、终检假阳性、订单 CI 覆盖不足、订单容器 root 运行、状态文档过期。
- 独立 acceptance 返回 BLOCKED：需修复 reviewer 问题并补独立恢复演练证据。
- 当前实施：停止危险自动回滚、终检异常强制失败、订单非 root、扩大 CI、补中英文 README 和状态资料。
- AI 接口保留但暂停扩展；人工录入仍是关键生产流程。
- 未获老板对具体新候选版本的生产发布批准，不得备份、迁移、部署或修改阿里云生产数据。
