# PROJECT_CONTEXT

佳旺美容美发商品录入系统是一个单租户内网 Web 应用，用于把商品多角度图片 ZIP 转成可审核的美容美发商品库。

技术基线：Next.js App Router、React、TypeScript、Tailwind、Node 20 LTS、SQLite WAL、独立持久化 Worker、Docker Compose。运行数据必须使用 Docker/WSL2 Linux 命名卷；源码目录位于 OneDrive 不代表数据库也应放在 OneDrive。

业务流程：上传并安全解压图片，保存不可变原图和去除 EXIF 的派生图；先做本地去重/条码候选，再用可配置 DeepSeek 视觉适配器进行视角分类、候选分组和背标字段提取；所有 AI 结果进入人工审核，审核员或管理员批准后才发布和导出。

权限：管理员管理账号、类目、AI 配置、备份和全部数据；审核员可导入、编辑、审核和发布；只读账号只能查询和导出已发布商品。

安全边界：API Key 环境变量优先、数据库备用密文用 APP_MASTER_KEY 保护；不记录密钥/Authorization/原图到日志；上传防 zip-slip/zip bomb/像素炸弹；原图仅通过鉴权流式接口访问；生产经 HTTPS 反向代理。
