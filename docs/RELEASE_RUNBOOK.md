# 发布与恢复手册

## 固定门禁

1. 候选版必须在 Node 20/Linux 通过源码检查、镜像构建和全新命名卷预览。
2. reviewer 和 acceptance 报告的关键项必须通过，预览结果必须展示给老板。
3. 每次发布必须得到老板明确批准，并记录 `APPROVAL_REFERENCE`。实现、检查或预览不等于发布批准。
4. 发布过程不删除、重建或替换任何生产数据卷。

## 标准流程

1. 使用 `validate-node20-candidate.sh` 完成 Node 20/Linux 验证。
2. 使用 `build-node20-candidates.sh` 构建候选镜像，保存镜像 ID/摘要清单。
3. 使用 `validate-isolated-preview.sh` 和 `start-isolated-preview.sh` 启动全新临时卷。
4. 完成浏览器验收、备份恢复演练、独立审查和老板批准。
5. 生产主机上依次执行 `production-deploy-prepare.sh`、`production-deploy-backup.sh`、`production-deploy-cutover.sh` 和 `production-finalize.sh`。备份必须同时包含两套 SQLite、订单上传文件和仓库媒体。
6. 上线后检查两个健康接口、容器状态、SQLite `quick_check`、关键数据计数和近期错误日志。

## 失败边界

- 预检、备份哈希、数据库完整性、镜像不可变性、健康或核心业务检查任一失败，立即停止发布。
- 切换或健康检查失败时，保留候选现场并输出 `MANUAL_RECOVERY_REQUIRED`。应用启动可能已经执行数据库迁移，因此不得自动把旧镜像连接到新数据库。
- 恢复前必须确认迁移向后兼容，或由老板明确批准在维护窗口从已校验备份同时恢复数据库、媒体和旧镜像。任何恢复操作都必须再次核对 SHA-256 和 SQLite `quick_check`。
- `production-finalize.sh` 默认要求媒体缺失、失败同步、待处理同步和死信均为 0；如业务确需非零阈值，必须显式设置对应 `MAX_*` 参数并写入审批记录。关键错误日志默认阻断终检。
- 不得在 GitHub、状态文档或日志中保存 `.env`、客户数据、上传图片、备份包或凭据。
