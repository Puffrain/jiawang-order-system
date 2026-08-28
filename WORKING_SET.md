# Working Set

## 2026-08-28 baseline-v2 已部署

- 资源等级：重型。公开标签 `baseline-v2` / `89fbe24` 已部署到阿里云测试服务器。
- GitHub 仓库 `Puffrain/jiawang-order-system` 已公开，采用 MIT License；`main` 已启用 `verify`、一次审批、管理员强制、线性历史、禁止强推和删除。
- `baseline-v1` 指向已通过 GitHub CI 的 `3ff147b`；当前修复尚未合并或标记新版本。
- 隔离预览曾在 `http://127.0.0.1:3113` 完成人工商品录入、审核、发布、订单与媒体同步、备份恢复和浏览器验收。
- 独立 reviewer 已在上一轮修复后返回 REVIEW PASS。
- 独立 acceptance 的恢复演练通过，但发现非 root 订单镜像运行期会由 Corepack 下载 pnpm 11.24，导致 Node 20 容器启动失败，结论为 ACCEPTANCE FAIL。
- 当前实施：订单 Web/Worker 生产入口改为 Node 直接运行，GitHub CI run `33151561438` 已通过真实镜像启动检查；等待 reviewer 和 acceptance 最终结论。
- AI 接口保留但暂停扩展；人工录入仍是关键生产流程。
- 已校验备份位于 `/root/jiawang-backups/20260828-162713-baseline-v2`，不得删除。
- 商品和媒体迁移前后计数一致；两库 quick_check、健康接口、零重启和关键日志扫描通过。
- 网关需保留生产覆盖端口 `127.0.0.1:8080:80`，宿主机 Nginx 依赖它。
- 旧镜像尚未清理；先补独立 reviewer/acceptance。
