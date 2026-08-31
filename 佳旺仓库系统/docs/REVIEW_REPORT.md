# Independent reviewer report — M6 snapshot

Review date: 2026-08-09 (Asia/Shanghai)

Verdict: **FAIL — the current snapshot is not ready for production release.**

## Scope and baseline

I reviewed the current source snapshot and the stated M6 acceptance goals, including authentication/RBAC and request gates, pipeline control semantics, budget and retry persistence, catalog/candidate projection and review, DeepSeek endpoint security, maintenance/backup/restore fencing, export generation/download, error serialization, and request-size handling.

`git status` shows the project files as untracked, so there is no tracked baseline or meaningful product diff to compare. Findings below apply to the current snapshot; they are not claims about an earlier commit. No product file was modified by this review. The only file created by this reviewer is this report.

## Verification evidence

| Command/check | Result | Evidence and limits |
| --- | --- | --- |
| `npm.cmd test` | **PASS** | 40 passed, 0 failed, 3 skipped out of 43. The skipped tests require the `better-sqlite3` native binding, unavailable under the current Node 24 runtime. |
| `npm.cmd exec -- tsx --test tests/pipeline/job-controls.test.ts tests/pipeline/item-retry-budget-generation.test.ts tests/pipeline/catalog-integration.test.ts` | **PASS** | 7 passed, 0 failed, 2 skipped (the two catalog SQLite cases). |
| `npm.cmd run typecheck` | **PASS** | Passed after the production build generated `.next/types`; a first invocation before that generation reported missing generated type files. CI should make this ordering deterministic. |
| `npm.cmd run lint` | **PASS** | 0 errors, 3 existing unused-variable warnings in `lib/jobs/http.ts`. |
| `npm.cmd run build` | **PASS** | Next.js production build completed; the same 3 lint warnings were emitted. |
| `npm.cmd run test:platform` | **PASS** | Platform self-test passed (password KDF, RBAC, validation, AES-GCM). |
| `npm.cmd run test:config` | **PASS** | Runtime config/named-volume smoke passed. |
| Node 20/native SQLite API and cross-process tests | **BLOCKED** | Current environment cannot load `better-sqlite3`; no real route/session/audit/CAS exercise was possible. |
| Docker daemon/E2E, real DeepSeek, browser E2E, disaster recovery, load/large-catalog tests | **NOT RUN** | Required external runtime/data were not available in this review. |

## Findings

### R-01 — High — DNS rebinding is still possible after SSRF validation

- **Severity:** High
- **Location:** `lib/ai/provider.ts:228-257` and `lib/ai/provider.ts:274-290`.
- **Evidence:** `request()` resolves the endpoint twice, rejects private/metadata answers, and compares the two answer sets. It then calls `fetch(endpoint, ...)` by hostname. The validated addresses are not pinned to the socket/dispatcher, and `fetch` performs its own DNS resolution. A hostname can therefore answer with a public address during validation and a private/metadata address when the connection is opened. The provider-security tests cover path escape and IPv4-mapped IPv6, but no test binds the checked address to the actual connection.
- **Impact:** An allow-listed hostname under DNS control can be rebound to an internal service or cloud metadata endpoint, defeating the provider SSRF boundary and potentially sending the bearer key to the wrong host.
- **Recommended action:** Use an HTTP connector/Undici dispatcher that connects to the validated IP while retaining the intended Host/SNI, or enforce equivalent egress pinning at the network layer. Add a DNS-change/connection-target integration test (including multi-address and redirect failure cases).

### R-02 — High — Catalog/config/audit/export mutations bypass the maintenance write lease

- **Severity:** High (data-integrity and restore-fencing risk)
- **Location:** `lib/db.ts:224-227` (`withTransaction()`); direct callers include `lib/catalog-repository.ts:165,261,283,311`, `lib/catalog/pipeline-candidate.ts:83,115,132,146,167,241,423`, `lib/deepseek-config.ts:198-225,272-275`, `lib/export/service.ts:56,97,100`, `lib/idempotency.ts:36-38`, and `lib/audit.ts:38-53`. Representative routes are `app/api/v1/catalog/products/route.ts:34-43`, `app/api/v1/admin/config/route.ts:21-42`, `app/api/v1/exports/route.ts:18-29`, and `app/api/v1/reviews/route.ts:31-79`.
- **Evidence:** `withTransaction()` only invokes `db.transaction`; it never calls `acquireWriteLease()` or checks the maintenance marker. The routes perform a route-level `requireSessionUser()`/`assertNotInMaintenance()` check, then parse/await work and issue these writes. Backup/restore enters maintenance and drains only registered write leases (`lib/backup/service.ts:588-591,750-752`; `lib/backup/service.ts:1551-1559`). A catalog/config/audit/export write can begin after the drain and still commit while the snapshot or database switch proceeds.
- **Impact:** Backups can contain a database snapshot and media/projection list from different moments; restore/database switching can race a mutation, causing lost writes, split-brain generations, incomplete catalog projections, or audit records that do not describe the durable product state. A route-level check cannot close this check-then-write race.
- **Recommended action:** Provide one maintenance-aware write-transaction boundary for every state mutation (including catalog projections, settings, audit, export metadata, and idempotency rows). Support nested use when a caller already holds a lease. Add an interruption test that starts maintenance between the request check and the mutation commit and verifies no post-drain write succeeds.

### R-03 — High — Review decision is not atomic across the catalog database and PipelineStore

- **Severity:** High
- **Location:** `app/api/v1/reviews/route.ts:55-79`, especially catalog edits/review at `:59-75` followed by `runtime.store.transitionItem()`/event/audit at `:77-79`; legacy `app/api/v1/review/items/[id]/decision/route.ts:10-22` updates only the catalog product.
- **Evidence:** The catalog transaction commits first. Pipeline item status and event are persisted in a separate PipelineStore transaction/backend call. A process crash, SQLite CAS conflict, database switch, or audit failure between these operations leaves the two sources inconsistent. The legacy decision endpoint has no PipelineStore update at all.
- **Impact:** A product may be published while its import item remains `needs_review`, or an item may be marked succeeded/reviewed while the product decision failed. Review queues, retries, counts, exports, and audit history can then disagree, and the legacy route can permanently leave such divergence for clients that still call it.
- **Recommended action:** Commit both projections in one SQLite transaction where possible. If the file-backed PipelineStore must remain separate, use a durable outbox plus idempotent reconciliation and expose a repair status. Add fault-injection tests for each commit order and update/remove the legacy endpoint so it cannot bypass the invariant.

### R-04 — High — Whole-job/item retry refund can commit independently of retry state

- **Severity:** High (budget/accounting correctness)
- **Location:** `lib/jobs/runner.ts:247-284` and `:320-334`; `lib/jobs/store.ts:348-399` and `:404-443`.
- **Evidence:** For an untouched `reserved` task, `runner.retry()`/`retryItem()` passes `() => this.ledger.refund(previousTaskId)` as `beforeCommit`. `PipelineStore.retryJob()`/`retryItem()` executes that callback at `:371`/`:420`, then mutates the job/items and persists at `:397`/`:442`. With the SQLite backends, ledger refund and PipelineStore save are separate CAS transactions; the latter can fail with `STATE_CONFLICT` or a database error after the refund has committed. A crash can occur in the same window. The tests cover normal refund and idempotent replay, but no cross-store commit-failure interruption is injected.
- **Impact:** The ledger can say `refunded` while the job remains failed/not retried (or the reverse), producing incorrect daily capacity, duplicate/omitted reservations, or a job that cannot be safely retried without operator reconstruction.
- **Recommended action:** Persist a retry plan and idempotency key first, then use a compensatable/outbox sequence for ledger and job state. Make refund replay-safe and provide durable reconciliation for every partial outcome. Add CAS/persistence-failure and process-interruption tests for both whole-job and item retry.

### R-05 — Medium-high — Durable provider error details are returned to pipeline clients

- **Severity:** Medium-high
- **Location:** `lib/ai/provider.ts:208-209`, `lib/jobs/runner.ts:485-489`, `lib/jobs/http.ts:47-57`, and the responses from `app/api/v1/import-jobs/route.ts:6-14`, `app/api/v1/import-jobs/[jobId]/route.ts:6-15`, and `app/api/v1/import-jobs/[jobId]/events/route.ts:20-35`.
- **Evidence:** A non-2xx DeepSeek response is stored as `{ status, body: text.slice(0, 500) }` on `AIProviderError.details`. `classifyError()` persists `details` in `item.error`/`job.error`. `handlePipelineError()` generalizes the 5xx message but still passes `candidate.details` to `apiError()`, while GET/list/SSE serialize the durable job/item objects unchanged.
- **Impact:** Reviewers and API clients can receive third-party response bodies, endpoint/path diagnostics, or other provider-supplied sensitive text. Message redaction does not protect the separately serialized `details` field.
- **Recommended action:** Persist only an allow-listed provider code/status and a diagnostic ID; do not persist provider bodies. Redact structured logs separately and add a route regression test with secret-like/path-containing provider text.

### R-06 — High — Synchronous unbounded export generation permits resource and disk exhaustion

- **Severity:** High (availability/resource exhaustion)
- **Location:** `app/api/v1/exports/route.ts:18-29`; `lib/export/service.ts:52-103`; UI trigger `app/catalog/page.tsx:82-98`.
- **Evidence:** POST inserts a row as `running` and awaits the complete export in the web request. CSV and image-manifest paths build full strings; XLSX builds an entire ExcelJS workbook and writes it at once. `listAllPublishedProducts()` repeatedly loads pages into one array, and the image-manifest query uses an unbounded `.all()`. There is no queue worker, per-user/global rate limit, concurrency cap, cancellation/abort propagation, or retention cleanup; any viewer can submit requests repeatedly and output files remain under the export root.
- **Impact:** Large catalogs or concurrent viewers can exhaust web-process memory/CPU, hit request timeouts, and fill the disk. A client disconnect does not necessarily stop generation.
- **Recommended action:** Return a bounded queued job (`202`) and process it in a worker with concurrency, row/byte, and per-user quotas. Stream CSV and use a bounded XLSX strategy, propagate cancellation, clean failed outputs, and implement retention/cleanup plus rate limiting.

### R-07 — Medium — Export pagination is not a consistent point-in-time snapshot

- **Severity:** Medium
- **Location:** `lib/export/service.ts:121-129`.
- **Evidence:** The exporter fetches the first published page and then issues separate `LIMIT 500 OFFSET ...` queries based on the earlier `total`. Product status and ordering can change between pages. There is no read transaction/snapshot or keyset cursor.
- **Impact:** A concurrent publish/unpublish/update can shift offsets, causing omitted or duplicated products/variants. The result may not represent any valid published-catalog snapshot, undermining the “export all published” acceptance criterion.
- **Recommended action:** Read under one SQLite read transaction/snapshot, or use a stable keyset cursor (`updated_at,id`) with an explicit export watermark. Record the watermark and row count used for reconciliation.

### R-08 — Medium — Browser export download duplicates the complete file in memory

- **Severity:** Medium
- **Location:** `app/catalog/page.tsx:82-96`.
- **Evidence:** After the server finishes, the client calls `await response.blob()`, creates an object URL, and then triggers an anchor download. The entire response is buffered before the browser can save it.
- **Impact:** A large export consumes another full copy of the file in browser memory and can freeze or crash the catalog UI even if the server remains healthy.
- **Recommended action:** Navigate directly to an authorized download URL/anchor (or use a browser streaming/file-handle API) so the browser does not first materialize the full blob.

### R-09 — Medium — Several JSON routes have no parser-level body limit

- **Severity:** Medium (unauthenticated login path raises the exposure)
- **Location:** `lib/validation.ts:157-163` (`parseJson()` calls `request.json()` without a byte cap); callers include `app/api/v1/auth/login/route.ts:20-40`, `app/api/v1/admin/users/route.ts`, `app/api/v1/admin/users/[id]/route.ts`, `app/api/v1/admin/config/route.ts`, `app/api/v1/admin/backups/route.ts`, `app/api/v1/exports/route.ts:18-27`, `app/api/v1/taxonomy/route.ts`, `app/api/v1/catalog/products/route.ts:34-42`, `app/api/v1/catalog/products/[id]/route.ts`, `app/api/v1/catalog/categories/[id]/route.ts`, `app/api/v1/groups/[id]/route.ts`, and `app/api/v1/review/items/[id]/decision/route.ts`.
- **Evidence:** Other pipeline routes use bounded `readJson()`, but these routes parse raw JSON before schema validation. The reverse proxy permits `client_max_body_size 64g` (`proxy/nginx.conf:35`). Login applies rate limiting before parsing but still allows one oversized body to be buffered by the web process; schema field limits do not protect JSON parser allocation or ignored extra fields.
- **Impact:** An unauthenticated or authenticated caller can cause excessive memory/CPU use with oversized JSON, potentially degrading login and administrative APIs.
- **Recommended action:** Replace `parseJson()` with one streamed, bounded parser that checks `Content-Length` and enforces a byte cap before `JSON.parse`; apply it to every JSON route, including login. Set route-specific proxy limits far below 64g.

### R-10 — Medium-high — Empty AI reruns are not idempotent

- **Severity:** Medium-high
- **Location:** `lib/catalog/pipeline-candidate.ts:271-364`, especially the duplicate check at `:275-277` and evidence inserts guarded at `:356-362`; the retry generation marker is supplied by `lib/jobs/runner.ts:376-411`.
- **Evidence:** `refreshExisting()` treats `(product_id, aiRunId)` in `field_evidence` as the idempotency marker. It increments the product revision and updates assets/variants before inserting evidence. When the provider returns no category and an empty `backLabel`, both insert loops are skipped, so no row containing that `aiRunId` is written. Replaying the same worker generation therefore misses the duplicate check and increments the revision again (and can append variants for grouped products). The existing catalog test only uses non-empty fields and is one of the SQLite-skipped tests.
- **Impact:** A crash/replay of an otherwise valid empty extraction can create unbounded revision/variant churn, duplicate asset links, and misleading audit/review history. Repeated retries may eventually bloat the catalog even though the AI result is unchanged.
- **Recommended action:** Persist a durable candidate-run row or an explicit sentinel evidence row for every AI generation, including empty results, with a uniqueness constraint on `(product_id, ai_run_id)`. Make the product mutation and marker insertion one transaction and add an empty-result replay test in the supported SQLite runtime.

## Acceptance decision

| Acceptance item | Status | Evidence / reason |
| --- | --- | --- |
| Pause/resume/retry domain controls and fresh budget generations | **PASS** | Targeted tests pass (7/7); terminal pause, idempotent retry, needs-changes checks, and stale-usage generation tests are covered. Cross-store failure handling remains R-04. |
| Reviewer RBAC, same-origin, CSRF, and JSON content-type gates (static) | **PASS** | Route/helper inspection and platform tests pass. |
| Real API/session/RBAC/CSRF/audit/SQLite integration | **BLOCKED** | Native `better-sqlite3` binding is unavailable under Node 24; the two catalog tests and write-lease test are skipped. |
| Catalog review ↔ pipeline item atomicity | **FAIL** | R-03; separate transactions and a legacy route bypass. |
| Maintenance fence covers all mutations during backup/restore | **FAIL** | R-02; several direct SQLite writes never acquire a write lease. |
| DeepSeek endpoint SSRF protection | **FAIL** | R-01; hostname is re-resolved by `fetch` after validation. |
| Pipeline error/privacy boundary | **FAIL** | R-05; durable provider body is exposed in `details`. |
| Export correctness, bounded resource use, and retention | **FAIL** | R-06 and R-07; synchronous in-memory generation, no quotas/cleanup, and no consistent snapshot. |
| Browser large-export behavior | **FAIL** | R-08; complete response is buffered as a Blob. |
| Request-size/resource boundary for all JSON routes | **FAIL** | R-09; raw `request.json()` on multiple routes and proxy limit of 64g. |
| Candidate retry idempotency for empty AI results | **FAIL** | R-10; no generation marker is stored when all extracted fields are empty. |
| Typecheck/lint/build/platform/config smoke | **PASS** | Commands above completed; lint/build report 3 warnings but no errors. |
| Node 20/Docker/real provider/browser E2E/disaster/load tests | **NOT RUN** | External runtime, provider credentials, and test datasets were not supplied/available. |

## Residual risks and review limits

- Backup and export download validation performs `lstat`/hash/path checks before opening a stream (`lib/backup/service.ts:386-395`, `app/api/v1/admin/backups/[id]/download/route.ts:24-30`, and the analogous export route). A local actor able to modify the service-controlled 0700 root could exploit a validation/open TOCTOU; use fd-based open/fstat if that actor is in scope. This is low risk under the documented volume permissions.
- No production DeepSeek endpoint, Docker daemon, Node 20 native SQLite runtime, disaster-recovery rehearsal, browser E2E, or 2,000-image/load dataset was exercised. Passing mock/unit tests does not establish those acceptance items.

Until R-01 through R-04, R-06 through R-10, and the blocked integration checks are addressed/run in the supported runtime, the snapshot should remain **FAIL / no production release**.
