# Handoff

## 2026-08-28 发布安全修复

公开仓库、MIT License 和 `main` 分支保护已经建立。已验证基线为 `baseline-v1` / `3ff147b`；当前工作在 `fix/release-safety-readme` 分支，尚未放行生产。

独立 reviewer 找到两个 P1：迁移后故障会自动切回旧镜像但不恢复数据库；终检发现关键日志、死信、积压或媒体缺失时仍可能输出成功。另有三个 P2：订单关键测试未全部进入 CI、订单容器以 root 运行、状态文档过期。独立 acceptance 因这些问题和未独立复现恢复演练而 BLOCKED。

当前修复将失败切换改为 `MANUAL_RECOVERY_REQUIRED`，为终检添加零容忍默认阈值和日志阻断，订单 Web/Worker 改为固定 UID 非 root，并新增一次性卷权限初始化。CI 将覆盖订单业务、跨系统同步、积分、商品投影、媒体并发和数据库并发。根目录新增中英文 README。

下一步：完成本地验证、提交分支、创建 PR、等待 CI，随后让原 reviewer 和 acceptance 复审。生产服务器和商品数据不得操作，除非老板对最终候选版另行明确批准。
