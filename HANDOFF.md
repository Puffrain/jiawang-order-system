# Handoff

## 2026-08-28 发布安全修复

公开仓库、MIT License 和 `main` 分支保护已经建立。已验证基线为 `baseline-v1` / `3ff147b`；当前工作在 `fix/release-safety-readme` 分支，尚未放行生产。

独立 reviewer 找到两个 P1：迁移后故障会自动切回旧镜像但不恢复数据库；终检发现关键日志、死信、积压或媒体缺失时仍可能输出成功。另有三个 P2：订单关键测试未全部进入 CI、订单容器以 root 运行、状态文档过期。独立 acceptance 因这些问题和未独立复现恢复演练而 BLOCKED。

当前修复将失败切换改为 `MANUAL_RECOVERY_REQUIRED`，为终检添加零容忍默认阈值和日志阻断，订单 Web/Worker 改为固定 UID 非 root，并新增一次性卷权限初始化。CI 将覆盖订单业务、跨系统同步、积分、商品投影、媒体并发和数据库并发。根目录新增中英文 README。

PR #1 的 GitHub Actions run `33140776035` 已全绿。reviewer 复审确认四项技术问题已解决，仅要求补全 README 的三个候选镜像参数并清理状态文档矛盾；这些文档修复正在同一 PR 中完成。下一步是最终 REVIEW PASS、独立恢复演练和 acceptance 复审。生产服务器和商品数据不得操作，除非老板对最终候选版另行明确批准。
