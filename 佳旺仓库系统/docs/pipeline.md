# Import pipeline

The import path is intentionally byte-oriented:

1. `POST /api/v1/uploads` creates a server-owned chunk directory. Chunk indexes
   are contiguous, bounded, and SHA-256 retries are idempotent.
2. Completion assembles bytes into a UUID-named immutable source asset. MIME is
   sniffed from bytes; a client filename never becomes a filesystem path.
3. ZIP uploads are parsed without invoking a shell. The extractor rejects
   zip-slip/absolute/UNC paths, encrypted entries, symlinks, nested archives,
   unsupported methods, excessive entries/bytes/ratios, and pixel budgets.
4. `ImportJobRunner` claims durable leases, derives metadata-free previews with
   sharp, and invokes a selected provider. Mock is deterministic; DeepSeek is
   opt-in and requires configured endpoint/model/key plus a confirmed vision
   capability. Inputs are bytes/data URLs only.
5. Token reservations are integer-only and bounded per task/day. Missing
   provider usage pauses the job instead of estimating a charge. Provider
   failures leave an item in `needs_review` so a human can continue.
6. AI drafts are candidate products/groups with suggested field evidence. A
   reviewer approval calls the catalog repository and publishes products and
   variants; no AI result is exported directly.

Queue/lease status (`queued`, `running`, `paused`, `cancelled`, `succeeded`,
`failed`) is stored separately from the durable business stage:
`queued → unpacking → preprocessing → classifying → extracting → grouping →
review_pending → completed`. A paused job retains its current stage so resume
does not pretend that earlier work completed again.

The API/worker runtime uses SQLite snapshot backends by default
(`SqliteStateBackend`, `SqliteBudgetStateBackend`). `PIPELINE_USE_FILE_STORE=1`
is a development fallback. The migration contract starts at
`migrations/010_pipeline.sql`; `migrations/012_job_stage.sql` adds the stage
projection without replacing the durable JSON snapshot.
SSE consumers can connect to `/api/v1/import-jobs/:jobId/events` and resume with
`Last-Event-ID`/`after`.
