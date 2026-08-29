# First Managed Baseline Plan

资源等级：重型
当前目标：维护已部署的订单生命周期与配送员版本，补齐独立复核和发布工具改进。

## 里程碑

1. `completed` 接管快照、Git 导入、隔离预览、人工商品全链路和备份恢复演练。
2. `completed` GitHub 公开仓库、MIT License、绿色 CI 基线和 `main` 分支保护。
3. `completed` 首轮独立 reviewer 与 acceptance；修复后 reviewer PASS，acceptance 的恢复项目通过但镜像入口验收 FAIL。
4. `completed` 修复迁移后故障处理、终检阻断、订单非 root 和 CI 覆盖。
5. `completed` 新增中英文 README，统一项目状态和发布文档。
6. `completed` PR #1 基线 CI 与 reviewer 复审通过；独立恢复演练通过，但 acceptance 发现订单镜像默认入口失败。
7. `completed` 运行期 pnpm/Corepack 问题已改为 Node 直接启动，并由 CI 的实际镜像启动检查覆盖。
8. `completed` 老板批准 `order-lifecycle-courier-20260829-r2`，完成可信构建、生产备份、数据原卷迁移、健康和数据终检。
9. `in_progress` 对本次远程发布完成独立 reviewer/acceptance 和公网 HTTPS 浏览器抽检；将无主机 Node 的 Docker 预检支持纳入单独改进。
10. `pending` 独立复核通过且得到清理批准后，清理旧候选镜像；始终保留已校验备份、命名卷和当前不可变镜像。

## 停止条件

- 真实凭据、客户数据或生产文件准备进入 Git 时立即停止。
- 镜像、Compose、备份、数据完整性、健康或核心业务失败时不得发布。
- 未获得老板对具体候选版的批准时不得修改生产。
