# Handoff

## 2026-08-28 发布安全修复

公开仓库、MIT License 和 `main` 分支保护已经建立。已验证基线为 `baseline-v1` / `3ff147b`；当前工作在 `fix/release-safety-readme` 分支，尚未放行生产。

独立 reviewer 最终复审为 REVIEW PASS。独立 acceptance 完成恢复演练后发现订单镜像默认入口失败：容器切换到 UID 1001 后，Corepack 找不到构建阶段 root 用户的 pnpm 10 激活记录，转而下载要求 Node 22 的 pnpm 11.24，导致 Node 20 容器持续重启。其余备份、哈希、SQLite、媒体和两次迁移项目均通过。

当前分支已将订单 Web 和媒体 Worker 的生产入口改为直接由 Node 启动，不再在运行期依赖 pnpm/Corepack。发布契约明确禁止旧入口，CI 增加镜像真实启动、健康接口、UID 1001、Worker 存活和零重启检查。本地新镜像已验证 Web 健康 200，Web/Worker 均为 `running restart=0`。

PR #1 当前基线提交 `995b4fe` 的 GitHub Actions run `33141622415` 已全绿。下一步是提交运行入口修复、等待新 CI，然后由独立 reviewer 和 acceptance 针对新提交复审。生产服务器和商品数据不得操作，除非老板对最终候选版另行明确批准。
