# Project Context

佳旺订单系统是单租户批发业务平台，根目录是订单/客户系统，`佳旺仓库系统/` 是商品录入和库存权威系统。两者通过签名内部接口同步，并由 Nginx 网关以同一域名对外提供订单根路径和 `/warehouse` 仓库路径。

技术基线是 Next.js/React/TypeScript、Node 20 LTS、SQLite WAL、Docker Compose；订单媒体和仓库任务由独立 Worker 处理。生产数据库、媒体和备份必须使用 Linux 命名卷，不放在源码目录、OneDrive 或 GitHub。

仓库系统管理商品身份、SKU、库存和上下架状态；订单系统管理客户、购物车、订单、定价、积分、聊天和销售展示。仓库 AI 结果只能作为候选与证据，人工审核后才可发布。

每次生产发布前必须有全新临时卷预览、独立审查、验收报告和老板对该候选版的明确批准。

源码公开托管于 `https://github.com/Puffrain/jiawang-order-system`，采用 MIT License。公开仓库不包含生产数据库、媒体、客户资料、备份、环境文件、证书或凭据；`main` 启用 CI、一次审批、禁止强推和禁止删除的分支保护。
