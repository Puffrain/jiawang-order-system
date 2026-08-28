# First Managed Baseline Plan

资源等级：重型
当前目标：修复独立审查发现的发布安全问题，完成可部署候选版和公开 GitHub 资料。

## 里程碑

1. `completed` 接管快照、Git 导入、隔离预览、人工商品全链路和备份恢复演练。
2. `completed` GitHub 公开仓库、MIT License、绿色 CI 基线和 `main` 分支保护。
3. `completed` 首轮独立 reviewer 与 acceptance；修复后 reviewer PASS，acceptance 的恢复项目通过但镜像入口验收 FAIL。
4. `completed` 修复迁移后故障处理、终检阻断、订单非 root 和 CI 覆盖。
5. `completed` 新增中英文 README，统一项目状态和发布文档。
6. `completed` PR #1 基线 CI 与 reviewer 复审通过；独立恢复演练通过，但 acceptance 发现订单镜像默认入口失败。
7. `in_progress` 运行期 pnpm/Corepack 问题和镜像实际启动 CI 已通过，等待 reviewer 与 acceptance 最终结论。
8. `pending` 全部关键项通过后，向老板申请最终候选版生产发布批准。

## 停止条件

- 真实凭据、客户数据或生产文件准备进入 Git 时立即停止。
- 镜像、Compose、备份、数据完整性、健康或核心业务失败时不得发布。
- 未获得老板对具体候选版的批准时不得修改生产。
