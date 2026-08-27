# 架构与数据流

## 服务

`web` 提供 Next.js 页面和 `/api/v1`；`worker` 从 SQLite 中领取带租约的任务并执行长流程；`proxy` 终止 HTTPS。生产 Compose 只运行一个 web 和一个 worker 副本。

## 数据流

分块上传 ZIP 后先在临时目录组装并计算 SHA-256，再进行流式安全解压。原图以 UUID/SHA-256 对象键不可变保存，派生图由图像处理器旋转、缩放、去除 EXIF 并压缩。低分辨率派生图用于视角分类和候选分组，背面/标签图才进入高分辨率字段提取。

AI 响应只写入带 revision 的 suggestion/evidence 表。审核员在原图、原始文本、规范化字段和置信度之间逐字段确认，批准后才生成 published 商品和规格记录。

## SQLite 约束

Live 数据库和媒体使用 Docker/WSL2 Linux 命名卷。OneDrive、SMB、网络盘和普通 Windows bind mount 不支持作为 live SQLite 路径。备份使用在线一致性快照和媒体 manifest，不直接复制单个 `.db` 文件。
