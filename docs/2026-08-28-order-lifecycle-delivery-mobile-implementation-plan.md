# 订单流程、配送、账号与全端适配实施计划

日期：2026-08-28  
依据：`docs/2026-08-28-order-lifecycle-delivery-mobile-design.md`  
资源等级：重型  
状态：待老板批准后实施  

## 1. 执行原则

- 保留生产商品、订单、客户、聊天、库存和媒体；所有数据库变更先在恢复副本验证。
- 每个里程碑使用独立分支和 PR，CI、独立 reviewer 和 acceptance 通过后才进入下一里程碑。
- 一个写入型代理只负责一个明确文件域；不得同时修改同一文件或同一状态机区域。
- 支付、物流和签收照片的真实凭据或数据不得进入 Git、文档、测试夹具或聊天。
- 未获得最终不可变候选版的生产批准，不修改阿里云服务。
- AI 接口保持现状，不纳入本计划。

## 2. 里程碑一：订单领域与安全迁移

目标：建立三类订单状态、版本控制、双方确认、客户发货前撤回修改、取消和隐藏，但不启用支付平台或送货员页面。

### 2.1 先写失败测试

新增测试：

- `tests/integration/order-lifecycle-state-machine.mts`：合法与非法状态转换。
- `tests/integration/order-revision-concurrency.mts`：订单版本冲突、重复请求和双方确认失效。
- `tests/integration/order-migration-runtime.mts`：从旧订单结构迁移，连续执行两次，核对行数和旧状态映射。
- `tests/e2e/order-edit-confirm-flow.mjs`：客户撤回、修改、重新提交、商家确认、客户确认、取消和隐藏。
- 扩展积分和仓库库存测试：取消只释放一次，重新提交不重复预留。

第一轮运行必须证明旧代码无法满足新断言，再开始实现。

### 2.2 数据库迁移

订单系统新增编号迁移模块，避免继续把复杂升级散落在启动文件中。预计文件：

- `migrations/001_order_lifecycle_v2.sql`：本次订单领域升级的固定、可追踪迁移版本。
- `lib/migrations.ts`：事务化执行、版本记录和并发启动保护。
- `lib/db.ts`：只保留基础初始化并调用迁移执行器。

迁移内容：

- 扩展 `orders`：`order_version`、`merchant_confirmed_version`、`buyer_confirmed_version`、`confirmation_status`、`payment_status`、`payment_method`、`fulfillment_status`、`fulfillment_method`、`customer_hidden_at`、迁移来源字段。
- 新增 `order_revisions`，保存每版商品、地址、备注、金额和配送方式快照。
- 建立状态、客户可见性和版本索引。
- 旧 `owner` 和角色迁移不在本里程碑执行，避免订单与权限同时扩大。

迁移验收：旧库副本连续启动两次；`quick_check=ok`、`foreign_key_check` 为空；订单、明细、报价、库存预留和积分行数符合映射报告。

### 2.3 单一订单领域服务

新增：

- `lib/order-lifecycle.ts`：状态机、完成条件和旧状态兼容映射。
- `lib/order-revisions.ts`：版本快照、差异校验和并发版本检查。
- `lib/order-commands.ts`：撤回、保存草稿、重新提交、双方确认、取消、隐藏。

修改：

- `lib/order-status.ts`：基于三类状态生成中文摘要。
- `lib/loyalty.ts`、`lib/warehouse-inventory.ts`：只接受领域事件，保证幂等。
- `app/api/orders/route.ts` 和 `app/api/orders/[id]/route.ts`：返回版本与三类状态。
- 停用原 `app/api/orders/[id]/status/route.ts` 的任意状态写入，改为调用明确命令。

### 2.4 客户与管理员订单接口

新增或调整：

- `POST /api/orders/[id]/withdraw`：客户发货前撤回。
- `PATCH /api/orders/[id]/draft`：按 `expectedVersion` 修改商品、地址和备注。
- `POST /api/orders/[id]/submit`：重新提交。
- `POST /api/orders/[id]/merchant-confirm`：管理员确认最新版本。
- `POST /api/orders/[id]/buyer-confirm`：客户确认同一版本。
- `POST /api/orders/[id]/cancel`：发货前取消并释放资源。
- `DELETE /api/orders/[id]/visibility`：只设置 `customer_hidden_at`。

每个接口校验会话、订单归属、当前版本、当前状态和幂等键；冲突返回 `409`，不做部分更新。

### 2.5 第一阶段页面

修改：

- `components/buyer/order-list.tsx`：显示双方确认进度、修改/取消/隐藏入口。
- `components/admin/order-center.tsx`：商家确认最新版本，禁止越级流转。
- 订单详情和聊天订单卡片：显示当前版本和三类状态摘要。

本阶段不大改整体视觉，只确保桌面与手机可操作，为第四阶段集中响应式改造保留边界。

### 2.6 第一阶段验收与停止条件

通过：订单相关测试、类型检查、Lint、构建、秘密扫描、订单镜像构建、恢复副本两次迁移。

停止：任何旧订单无法映射、库存/积分重复释放、发货后仍可修改、版本冲突覆盖数据或数据库检查失败。

## 3. 里程碑二：支付、物流与送货员

目标：完成支付接口占位、现场支付、快递信息、送货员账号与配送凭证。

### 3.1 先写失败测试

新增：

- `tests/integration/payment-state-machine.mts`：未付款发货阻断、现场支付完成条件和回调幂等。
- `tests/integration/shipment-state-machine.mts`：快递与个人配送状态。
- `tests/integration/courier-access-control.mts`：送货员只能读取本人订单。
- `tests/integration/delivery-proof-media.mts`：格式、大小、路径、权限和清理。
- `tests/e2e/courier-delivery-flow.mjs`：登录、开始配送、送达、失败。

### 3.2 数据表与领域模块

新增编号迁移：

- `payment_attempts`：平台、订单版本、金额分、状态、幂等键、脱敏平台标识。
- `shipments`、`shipment_events`：配送记录和轨迹。
- `delivery_assignments`：管理员指派、送货员和状态。
- `delivery_proofs`：凭证类型、受保护文件引用和异常原因。
- 必要的唯一索引、外键和事件幂等约束。

新增模块：

- `lib/payments/provider.ts`、`wechat.ts`、`alipay.ts`、`capabilities.ts`。
- `lib/payments/manual.ts`：现场收款确认。
- `lib/logistics/provider.ts`、`official-links.ts`。
- `lib/delivery.ts`、`lib/delivery-media.ts`。

未配置商户或物流凭据时，provider 返回明确 `NOT_CONFIGURED`，不得使用示例凭据或外部测试账号。

### 3.3 管理员接口和页面

- 支付能力查询、创建支付意图和回调入口。
- 管理员确认现场收款。
- 快递公司、运单号和官方查询链接录入。
- 创建、停用送货员账号并指派个人送货订单。
- 管理员查看配送状态和送达凭证。

在线支付按钮由能力接口控制；未配置时不显示。回调验签框架和金额/版本检查保留，真实商户号接入单独审批。

### 3.4 送货员独立页面

预计新增：

- `app/courier/login/page.tsx`。
- `app/courier/page.tsx` 和配送详情页。
- `app/api/auth/courier/*`。
- `app/api/courier/deliveries/*`。

服务端查询必须包含 `assigned_courier_user_id = session.userId`。配送电话和地址仅在任务有效期间返回；日志不记录完整地址或电话。

### 3.5 媒体和数据安全

签收照片进入独立命名卷或现有受保护媒体卷的独立目录。Compose、备份脚本、生产数据检查和恢复脚本增加该目录，但源码归档和 Git 忽略规则明确排除业务媒体。

### 3.6 第二阶段验收与停止条件

通过：支付/配送状态、越权、媒体安全、幂等、备份恢复和浏览器流程。

停止：未付款可发货、送货员可读取他人订单、照片可匿名访问、现场支付未确认即可完成、支付回调可篡改金额或版本。

## 4. 里程碑三：管理员能力权限、仓库桥接与头像

目标：所有管理员拥有完整业务权限，同时主管理员独占账号和安全配置；修复截图中的错误拒绝。

### 4.1 权限测试先行

新增矩阵测试：

- `super_admin`：全部业务和安全配置。
- `admin`：订单、商品、库存、仓库、消息、发货、收款和物流。
- `courier`：仅本人配送。
- `buyer`：仅客户自己的业务。
- 最后一个主管理员不能被停用、降级或删除。
- 普通管理员通过签名会话桥接进入仓库并完成业务操作。

截图问题先复现并记录具体失败请求、会话角色和守卫，再修改权限代码。

### 4.2 能力权限层

新增 `lib/permissions.ts`，定义角色和能力；修改 `lib/auth.ts`、`lib/auth-guards.ts`、`lib/session.ts` 和所有 `role === "owner"`/`requireApiRole("owner")` 业务守卫。

将现有 `owner` 迁移为 `super_admin`，普通管理员为 `admin`。会话继续有效，并从用户表读取实时角色。安全配置、支付密钥和账号管理接口要求主管理员能力。

仓库侧修改：

- `佳旺仓库系统/lib/integration-auth.ts` 与订单会话接口的角色映射。
- `佳旺仓库系统/lib/session.ts` 和导航可见性。
- API 最低角色判断，使订单系统管理员具备完整仓库业务能力。
- 保留仓库原生只读账号，不自动提升。

### 4.3 头像

新增：

- `user_avatars` 迁移、当前头像引用和清理队列。
- `lib/avatar-media.ts`：内容检测、像素/大小限制、方向纠正、压缩和随机文件名。
- `/api/profile/avatar` 上传、更换和读取接口。
- 客户、管理员、送货员账号页面头像控件。
- 仓库会话桥接返回头像 URL，仓库 shell 显示同一头像。

优先使用项目已有图片处理库；若能力不足，选择维护活跃、许可证兼容的成熟开源库，并固定版本、记录来源和安全扫描。

### 4.4 第三阶段验收与停止条件

通过：完整角色/能力矩阵、仓库业务操作、最后主管理员保护、头像处理和媒体访问。

停止：普通管理员仍出现错误拒绝、任何非主管理员可改安全配置、送货员权限扩大、仓库原生只读账号被提升、头像路径穿越或未授权读取。

## 5. 里程碑四：全端响应式界面与候选发布

目标：完成客户、管理员、仓库和送货员的统一移动端体验，并形成可发布候选。

### 5.1 兼容性基线和复现

- 收集华为/荣耀问题页面、浏览器版本、系统版本、视口、字体缩放和复现步骤。
- 使用 Playwright 建立 360x800、390x844、412x915、768x1024 和桌面视口。
- 对不支持的浏览器能力增加 feature detection 和可用降级，不通过 UA 猜品牌。

### 5.2 页面改造

重点文件：

- `app/globals.css`、`app/layout.tsx` 和通用导航。
- 客户商品、购物车、订单详情、修改确认、支付和物流页面。
- 管理员订单、客户消息、发货、收款、送货员管理和账号页面。
- 送货员任务列表、详情、导航和凭证上传。
- `佳旺仓库系统/app/globals.css`、`components/app-shell.tsx`、商品、审核和设置页面。

具体要求：手机宽表改为列表/卡片，触控区约 44 像素，安全区适配，弹窗窄屏全屏或底部面板，系统大字体和软键盘不遮挡操作，无悬停依赖，无关键横向溢出。

### 5.3 浏览器和视觉验收

- Playwright 截图和交互流程覆盖所有固定视口。
- 检查控制台错误、失败请求、文本溢出、元素遮挡和不可点击控件。
- 在可用的华为/荣耀真机或用户设备上完成微信/企业微信内置浏览器冒烟。
- 真机不可得时标为 `NOT RUN`，不能用模拟视口冒充真机通过。

### 5.4 隔离预览与恢复演练

- Node 20 Linux 完成两套安装、类型检查、Lint、测试、构建和镜像构建。
- 使用全新命名卷启动订单 Web、媒体 Worker、仓库 Web、仓库 Worker 和网关。
- 使用脱敏或合成数据完成订单修改、支付选择、快递、个人配送、收货、头像和权限全流程。
- 用最新生产备份的受控恢复副本连续运行全部迁移两次；核对哈希、SQLite、外键、商品/媒体计数和关键订单。

### 5.5 独立审查、验收和生产批准

Reviewer 检查安全、正确性、并发、兼容性、回归、测试和文档。Acceptance 对原始需求逐项返回 `PASS / FAIL / BLOCKED / NOT RUN`。实现者不得作为唯一 reviewer 或 acceptance。

全部关键项通过后生成不可变镜像摘要、迁移版本、验收报告和回滚边界，展示隔离预览，并再次向老板申请生产批准。

## 6. GitHub 与分支安排

建议 PR 顺序：

1. `feat/order-lifecycle-v2`：迁移、状态机、接口和基础页面。
2. `feat/payments-logistics-courier`：支付占位、现场收款、快递和送货员。
3. `feat/admin-permissions-avatars`：能力权限、仓库桥接和头像。
4. `feat/responsive-mobile-experience`：全端响应式和兼容性。
5. `release/order-platform-v3`：仅发布资料、不可变镜像和验收记录。

每个 PR 必须从最新 `main` 创建，不混入本地 `TASK_STATE.md` 等其他任务改动。

## 7. 每个 PR 的统一验证

- 目标测试先红后绿。
- `pnpm run typecheck`。
- 对修改文件执行只读 Lint，并运行全量 CI Lint。
- 相关集成/E2E 测试和现有回归测试。
- `pnpm run scan:secrets`。
- `pnpm run build`。
- Compose 展开、部署契约和候选镜像构建。
- 涉及仓库时运行仓库类型检查、测试和构建。
- 独立 reviewer 与 acceptance 给出明确结论。

## 8. 总体完成标准

- 原始四项需求和后续确认的送货员需求均有通过证据。
- 现有商品、媒体、订单和客户数据无丢失；迁移可重复且恢复演练通过。
- 未配置支付/物流凭据时系统清晰降级，人工订单与现场支付可用。
- 所有管理员可完成业务操作，主管理员安全边界有效，送货员严格隔离。
- 主流手机视口无关键布局或操作缺陷；华为/荣耀问题有复现和回归证据。
- GitHub 只含源码、迁移、测试、脱敏日志和文档。
- 生产部署必须取得最终候选版的单独明确批准。
