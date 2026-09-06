# 项目协作规范

## 唯一主线

- 唯一开发、验收和发布根目录是当前 Git 仓库根目录。
- 不在仓库旁复制平行可开发版本；历史版本移出工作区后以压缩归档或只读备份保存。
- 所有功能修改必须保留用户已有未提交改动，禁止 `reset --hard`、`checkout --` 或覆盖本地开发者工具配置。

## 分支与版本

- 日常功能从 `release/*` 或短期 `feature/*` 分支开始，分支名使用 `feature/<topic>`、`fix/<topic>`、`chore/<topic>`。
- 发布分支保持可构建；发布版本使用不可变 SemVer 标签 `vMAJOR.MINOR.PATCH`，标签一旦发布不得移动。
- 发布前记录提交、变更范围、验证证据、恢复点和未验收边界；未经明确批准不得提交、推送、部署或删除历史资料。
- 旧版本清理必须先生成文件清单和 SHA-256，确认不含 `.git`、数据库、密钥、上传资源或唯一源码后再执行可恢复删除，并在 `docs/version-governance.md` 记录。

## 质量门禁

提交或发布候选至少运行：

```text
pnpm run typecheck
pnpm run lint
pnpm exec next build --webpack
pnpm run test:miniprogram-contract
pnpm run scan:secrets
pnpm run test:deployment-config
git diff --check
```

涉及订单、评价、支付或小程序页面时，必须追加对应专项契约测试和 JavaScript 语法检查。默认 Turbopack 在当前 Windows 深路径下可能失败，发布构建以 Webpack 命令为准。

## 配置与数据边界

- `miniprogram/project.config.json`、`miniprogram/project.private.config.json` 仅是本地开发者工具状态，不覆盖、不提交。
- `.env*`、证书、私钥、数据库、上传资源和运行日志不得写入 Git、测试夹具或交接文档。
- 真实微信登录、支付、退款、真机视觉和 Docker 验收必须标记为 `PASS`、`BLOCKED` 或 `NOT RUN`，静态检查不得替代真实联调。

## 状态与交接

每个阶段更新 `TASK_STATE.md`、`WORKING_SET.md` 和 `HANDOFF.md`，记录目标、修改文件、验证命令、证据、阻塞和下一步。重大决策写入 `DECISIONS.md`；不把“未运行”描述为“已完成”。
