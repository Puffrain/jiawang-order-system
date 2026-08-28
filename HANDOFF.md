# Handoff

## 2026-08-28 baseline-v2 阿里云部署

老板已批准把测试服务器升级到公开仓库标签 `baseline-v2`（提交 `89fbe24`），保留并迁移现有商品数据，旧程序可清理。部署主机为 `101.132.41.57`，应用目录 `/opt/jiawang-commerce-new`。

上线前已生成并验证完整备份 `/root/jiawang-backups/20260828-162713-baseline-v2`，包含两套 SQLite、订单上传、仓库媒体、源码、Compose 和镜像信息。源码通过本地 `git archive baseline-v2` 传输，压缩包 SHA-256 为 `97235e4f038b908be499a41af6580342c59f739b32737a2f2c08621a02cb3f86`，远端文件数 458，关键配置核对通过。

三套候选镜像已构建并上线：订单 `c6494f39...`、仓库 Web `ba9de5da...`、仓库 Worker `0f0e1e69...`。中国网络构建使用阿里云 Debian 镜像和 npmmirror；正式源码未因镜像站改变。旧 `.env` 的 `APP_MASTER_SECRET` 已在服务器内部原值改名为 `APP_MASTER_KEY`，值与运行容器一致，原文件保留为权限 600 的备份。

切换后发现外层 Nginx 固定转发 `127.0.0.1:8080`，而候选 Compose 未发布该端口。生产镜像覆盖配置已为 gateway 增加 `127.0.0.1:8080:80`，只重建网关后恢复内外健康。五个容器均 `running`、`restart=0`；公网 HTTPS、两个内部健康接口均通过。

迁移前后数据一致：订单侧 products=23、productImages=50、imageFilesMissing=0；仓库侧 publishedProducts=22、publishedAssets=50；两库 `quickCheck=ok`，pending/failed/dead 队列均为 0。终检脚本输出 `FINALIZE_PASS`。

旧镜像尚未清理，已校验备份必须保留。独立 reviewer/acceptance 子代理工具连续返回参数解析错误，本轮不能把主代理终检冒充独立复核；下一步优先补做只读独立审查，再决定清理旧镜像。
