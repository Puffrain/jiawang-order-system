# First Managed Baseline Plan

资源等级：重型
当前目标：完成首个可追溯、可验证、可回滚的正式基线。
产品重点：人工录入商品；AI 仅保留接口，本轮暂停扩展。

## 里程碑

1. `completed` 固定接管前源码快照，建立 Git 未验证导入节点。
2. `completed` 修复生产必填配置、仓库 base path、Docker 检测、秘密扫描与发布/回滚脚本。
3. `completed` 建立 Node 20 CI 与发布手册，完成静态、构建和运行时验证。
4. `completed` 用隔离卷完成人工商品录入、图片、规格、库存、审核、发布和订单同步。
5. `completed` 完成备份、哈希、SQLite 完整性、两次幂等迁移和恢复演练。
6. `blocked` 独立 reviewer 和 acceptance：子代理平台参数解析 EOF。
7. `pending` 独立检查通过后审计 diff、创建正式提交和 `baseline-v1`，再创建 GitHub 私库并设置保护。
8. `pending` 向老板展示报告；只有老板明确批准具体候选版后，才安排生产备份和发布。

## 停止条件

- 真实凭据、客户数据或生产文件准备进入 Git 时立即停止。
- 镜像、Compose、备份、数据完整性、健康或核心业务失败时不得发布。
- 未获得老板批准时不得修改生产。
