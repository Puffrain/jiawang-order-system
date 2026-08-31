# Import-job controls: independent review

审查日期：2026-08-09（Asia/Shanghai）  
审查范围：`pause`、`resume`、`retry` API 路由、`ImportJobRunner`/`PipelineStore` 控制语义、导入页 UI、RBAC/同源/CSRF/JSON 边界及控制测试。此文件是只读审查结论；本批次未修改源代码。

## 总结

结论：`FAIL`。认证和请求安全边界已经接入，基础 pause/resume/retry 流程及预算世代测试通过；但尚有关键状态机与原子性缺口，不能据此接受原始目标。优先修复 F-01、F-02、F-03、F-04 后再验收。

## 验证证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 控制单元测试 | `PASS` | `node --import tsx --test tests/pipeline/job-controls.test.ts`：3 pass |
| 全部测试 | `PASS`（2 个环境跳过） | `node --import tsx --test "tests/**/*.test.ts"`：30 pass，2 skip；跳过项均为当前 Node 无 `better-sqlite3` native binding |
| TypeScript | `PASS` | `node_modules\\.bin\\tsc.cmd --noEmit`，退出码 0 |
| ESLint | `PASS` | `node_modules\\.bin\\eslint.cmd .`，退出码 0 |
| Next production build | `PASS` | `node_modules\\.bin\\next.cmd build` 成功；构建清单包含三个控制路由 |
| 状态/HTTP 探针 | `FAIL`（见 F-03/F-04） | 终态 pause 返回原终态；重复 retry 返回 `JOB_RETRY_STATE`/HTTP 400；未知 job 也映射 HTTP 400 |
| API 集成（真实会话、CSRF、审计 SQLite） | `NOT RUN` | native `better-sqlite3` binding 不可用，无法在本环境建立真实登录会话/审计查询 |

## 要求逐项判定

| 原始要求 | 判定 | 依据 |
| --- | --- | --- |
| 服务端 reviewer RBAC | `PASS`（静态） | 三个 POST 路由均调用 `requirePipelineRole(request, "reviewer")`；该 helper 使用最小角色层级，viewer 会被拒绝 |
| same-origin / CSRF | `PASS`（静态） | `requirePipelineRole` 调用 `assertSameOrigin`、非安全方法调用 `assertCsrfToken` |
| JSON（含空 JSON） | `PASS`（静态） | 三路均 `readJson`；`readJson` 强制 `application/json`，空文本返回 `{}` |
| pause 仅 queued/running | `FAIL` | `PipelineStore.pauseJob` 对 `succeeded`/`failed`/`cancelled` 直接返回原对象（F-03） |
| resume 仅 paused | `PARTIAL` | paused 可恢复；queued/running 做幂等 no-op，但错误码/HTTP 状态未按冲突语义返回 |
| retry failed/cancelled/needs_changes 且不覆盖已发布 | `FAIL` | 当前只接受 job `failed`/`cancelled`；没有 `needs_changes` 计划/UI；候选状态检查存在 fail-open 分支（F-02、F-05） |
| 幂等状态转换 | `FAIL` | pause 手工重复和 resume queued/running 可 no-op；retry 第一次后 job 为 queued，再次请求抛 `JOB_RETRY_STATE`（F-04） |
| runner/store 持久化 | `PARTIAL` | 控制方法写入 snapshot、事件并由路由审计；预算退款与状态校验顺序不是原子操作（F-01） |
| 审计 | `PASS`（静态）/`NOT RUN`（运行时） | 成功路由在响应前调用 `recordAudit`；真实 SQLite 写入因 native binding 未运行 |
| UI 控件 | `PARTIAL` | 列表与详情页均有 pause/resume/retry；retry 只展示 failed/cancelled，未覆盖 needs_changes（F-02） |
| 控制测试 | `PARTIAL` | 有 pause/resume、失败条目保留、预算世代/未知用量测试；缺少真实 API RBAC/CSRF/JSON、终态冲突、重复 retry、已发布/needs_changes 场景 |

## 发现

### F-01 — 高：retry 在状态/发布校验前退款，失败请求会改变预算（原子性破坏）

位置：`lib/jobs/runner.ts` 的 `retry`；`lib/jobs/store.ts` 的 `retryJob`。

`runner.retry` 先对 `reserved` 任务调用 `ledger.refund(previousTaskId)`，随后才调用 `store.retryJob` 做 job 状态校验和候选检查。对一个仍为 `queued` 的 job，调用 retry 会抛 `JOB_RETRY_STATE`，但旧预算已变成 `refunded`；探针实际输出：

```json
{"code":"JOB_RETRY_STATE","status":"refunded","dailyReserved":0}
```

同样地，已批准/已发布候选导致的拒绝也可能留下退款副作用；若 SQLite snapshot CAS 在退款后失败，预算和 job 状态还会分叉。应先完成纯校验/生成 retry plan，再在可补偿的事务顺序中同时提交预算世代和 job 状态，或提供明确回滚/补偿路径。

### F-02 — 高：`needs_changes` 重试路径未实现

位置：`lib/jobs/store.ts:346-351`、`lib/jobs/runner.ts:267`、`app/imports/page.tsx:298`、`app/imports/[jobId]/page.tsx:79`。

存储层只接受 job 状态 `failed` 或 `cancelled`；目录商品的 `needs_changes` 状态没有被转换为可安全重试的 item/job 计划。两个 UI 页面也只在 `failed`/`cancelled` 显示“重试”。因此被审核退回修改的候选无法按要求安全重跑，且没有证明不会覆盖已发布版本的测试。

建议：以 item/product 维度建立 retry plan，只重置 `needs_changes` 对应且未 `approved`/`published` 的 item；保留其他已完成/已发布 item，不把整个 job 粗暴重置。

### F-03 — 高：pause 对终态静默成功，且领域冲突 HTTP 状态码错误

位置：`lib/jobs/store.ts:307-313`、`lib/jobs/http.ts:56-61`。

`pauseJob` 先判断 `TERMINAL_JOB` 并返回原 job，所以对 `succeeded`、`failed`、`cancelled` 的 pause 请求返回 200/原状态，而要求明确限定 pause 只能作用于 queued/running。另一方面，`pipelineStoreError` 没有 `status`，其 `validation` class 被 `handlePipelineError` 映射为 400；例如探针显示未知 job 的 `JOB_NOT_FOUND` 和第二次 retry 的 `JOB_RETRY_STATE` 都是 HTTP 400，而资源不存在/状态冲突应分别为 404/409。错误码虽存在，HTTP 合同不完整。

### F-04 — 高：retry 非幂等

位置：`lib/jobs/store.ts:346-350`。

首次 retry 将 job 置为 `queued` 并增加 `retryCount`；随后相同控制请求不再被识别为“已完成的 retry”，而是抛 `JOB_RETRY_STATE`。这与“幂等状态转换”不符，也会让浏览器在网络超时后重发时显示失败。应持久化控制世代/幂等键并对同一已排队 retry 返回当前 job（同时避免把一个原始 queued job误判为 retry）。

### F-05 — 中高：已发布保护有 fail-open 分支

位置：`lib/jobs/runner.ts:267-274`。

候选 item 在 `catalog` 不存在、或 `getProduct` 查不到记录时 callback 返回 `true`，即允许重试。这在文件存储回退、目录数据库暂时不可用或链接损坏时，无法证明目标不是 `approved`/`published`，却继续放行。安全要求应 fail-closed：候选状态未知时返回专用冲突码，不执行 retry。

### F-06 — 中：预算世代虽已补齐，跨存储提交仍需验证

位置：`lib/jobs/runner.ts:245-281`、`lib/jobs/store.ts:346-378`。

新 retry task id、旧任务未知用量拒绝和 settled 任务保留已由测试覆盖，属于改进；但退款、snapshot 写入、审计写入分属不同持久化边界。仍需增加 CAS/失败补偿测试，证明任一写入失败不会留下“预算已退款、job 未重试”状态（与 F-01 相关）。

### F-07 — 中：resume 在开发/inline 模式只入队，不执行

位置：`app/api/v1/import-jobs/[jobId]/resume/route.ts:13-15`、`lib/jobs/runner.ts:234-243`。

现有基础 job POST 在非生产环境会直接 `runner.run`；resume 路由只调用同步 `runner.resume` 并返回 queued，没有 inline 执行分支。若开发部署没有独立 worker，用户点击恢复后任务会一直排队。应返回明确 `execution`（worker/inline）并与既有提交语义一致，或在 UI/部署文档中明确必须运行 worker。

### F-08 — 中：API 安全与冲突场景缺少可执行测试

位置：`tests/pipeline/job-controls.test.ts`。

当前测试覆盖 pause/resume、失败条目保留、预算世代和未知用量；没有真实 route handler 的 reviewer/viewer、Origin、CSRF、错误 content-type/空 JSON、审计记录、终态冲突、重复 retry、needs_changes、approved/published 保护测试。由于 native SQLite binding 不可用，本轮只能静态判定这些项，不能宣称运行时验收通过。

## 建议验收门槛

修复 F-01～F-05 后，至少补充以下自动化断言再重新运行 acceptance：

1. 终态 pause 返回 `JOB_PAUSE_STATE`/409；缺失 job 返回 `JOB_NOT_FOUND`/404；非法状态转换统一 409。
2. 同一 retry 请求重放返回相同 retry 世代且不重复退款/预留；状态校验失败不改变 ledger。
3. `needs_changes` item 可单独排队，`approved`/`published` item 永不重置；候选状态未知时 fail-closed。
4. 路由测试覆盖 reviewer/admin、viewer、缺 Origin、错误/缺 CSRF、`application/json` 空体与错误 JSON，并查询 audit_log。
5. 在带可用 `better-sqlite3` 的 Node/Docker 环境运行上述 API 集成测试，确认跨进程 CAS、维护模式和 worker poll 语义。

