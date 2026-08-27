# Working Set

## 2026-08-21 Current Focus

- Source-level contracts remain green: cross-system sync, archive/sync, chat-order navigation, preview isolation, and candidate scripts. Warehouse coordination safety is 6/6 and media streaming is 1/1.
- The only safe next execution path is a real Node 20/Linux environment with working native dependencies and Docker Engine. Current Windows runtime is Node 24.19.0; WSL and Docker Engine are permission-blocked, and native SQLite bindings are absent.
- Do not access production, use old images as final candidates, or weaken the preview gate. Once the environment is available, run `scripts/validate-node20-candidate.sh`, build immutable candidates, start the fresh-volume preview, and complete browser/reviewer/acceptance gates.

## 2026-08-20 Current Focus

- Source hardening now includes controlled current Outbox repair, pending/dead replay boundaries, media claim fencing, revision-specific files, retryable cleanup, and standalone media Worker testing with unchanged production defaults.
- New verification lives in the Outbox runtime, migration 021 runtime, warehouse media concurrency runtime, isolated-preview safety contract, and the 15-gate Node 20 candidate script.
- PASS now: warehouse TypeScript; cross-system, archive/sync, chat-order and isolated-preview contracts. Native migration/inventory/Outbox/media runtimes remain pending Node 20/Linux.
- Next: run all 15 gates on Node 20/Linux, build immutable images, and use only fresh temporary preview volumes. No production access before isolated acceptance and explicit approval.
- Reviewer status: RESOLVED for source-level P1/P2 findings. Runtime remains pending solely because Node 20 download and Docker Engine access are blocked by the approval service, not because a candidate test failed.

## Current Objective

Finish the local candidate for three-system product archive, detail, and
synchronization reliability. Production remains on the mature version.

## Active Work

- Warehouse worker: immutable current-state product events, revision/hash
  acknowledgement, publish history, soft-deleted SKUs, and inventory safety.
- Order data/API: archive and deletion policy, restore, merchant price
  override, category keys, curated recommendations, related products, and
  seed control.
- Buyer/admin UI: archive management, merchant preview, backend-driven detail
  recommendations, stale-cart handling, and refresh lifecycle.
- Main integration: signed projection endpoint, active/inactive tombstones,
  cart/order final validation, contracts, previews, review, and acceptance.

## Constraints

- Warehouse product state is authoritative; merchant actions cannot reactivate
  a warehouse product or rewrite its identity, SKU, or inventory.
- A warehouse product hidden in the order system returns only after an actual
  later warehouse inactive-to-active revision transition.
- Media delivery is independently retryable and cannot block product, SKU,
  price, inventory, or sale-state projection.
- Local Windows Node 24 `better-sqlite3` failures are environment skips only;
  Node 20/Linux SQLite evidence remains required before release.

## Verified In Current Checkpoint

- Order Node 20/Linux production build and TypeScript pass. Candidate image manifest is sha256:0cb65afd3d58d5a676d76f53800336e1e92fd21833073e8ee560bcc21a4abcce.
- Buyer detail uses the detail API, refreshes on focus/visibility and every 15 seconds, and disables purchase after unavailability.
- Curated recommendations are capped at 6; related products exclude them, require a live SKU, and are capped at 8.
- Warehouse Docker context was reduced from about 660 MB to 14 KB by ignoring historical .next-* directories.
- Outbox claims one event per lease; migration 021 has optimizer-safe JSON guarding; media replacement old files are retryable and reference-fenced.
- Current runnable checks: warehouse TypeScript, warehouse coordination safety 6/6, warehouse media stream, root chat-order navigation, root cross-system sync, and root product archive/sync contracts all pass.
- Real SQLite 3.53.1 applies migrations 001-021 with valid published/draft Outbox data and malformed JSON; historical publication backfill and `quick_check=ok` pass.
- Current Outbox payload reuse validates JSON/hash identity; damaged current pending/dead payload repair is audited by old-byte SHA-256 only. Supersede clears leases. Media writes and completion are fenced by the current unexpired claim token.

## Current Blockers

- Product manager is upgraded and the order projection runtime passes. Independent review then exposed legacy migration, inventory idempotency, outbox concurrency, media cleanup, and effective-price consistency gaps; source fixes are present and warehouse TypeScript/migration checks pass.
- Warehouse Web/Worker images are still not verified. The final order image must also be rebuilt because media cleanup changed after candidate final3.
- Focused Node 20 inventory and dual-worker runtime tests, delayed old-media completion, isolated preview, browser matrix, fresh independent reviewer, and acceptance remain required. Production is unchanged.
- Added inventory runtime test and migration claim-field checks. Media same-asset newer revision now always downloads current bytes and cleans the replaced file after commit. Docker approval service currently rejects even a harmless Node 20 probe with a 404 model error, so all Node 20 runtime/build/preview work remains NOT RUN rather than passed.
- Correct-root order/chat contracts remain PASS and warehouse TypeScript remains PASS. Node is still v24.18.0 without nvm-windows; do not claim Node 20 evidence until Docker or a real Node 20 install is available.
- Windows warehouse inventory initialization still fails before assertions because `better-sqlite3@11.10.0` has no `node-v137-win32-x64` binding; Docker/WSL and the Bash migration path are unavailable.
- Migration history backfill now has a passing cross-platform real-SQLite test. A latest independent reviewer is running. Production remains unchanged; do not deploy or claim completion without Node20 runtime/build/preview/acceptance evidence.

## Next Checkpoint

Run the final Node 20/Linux build and real SQLite migration, inventory, dual-worker, and delayed-media tests in an isolated container; then create the temporary-volume preview, browser acceptance, independent review, and user approval gate. Do not access production before those gates.
