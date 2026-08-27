# Product Archive, Detail, and Synchronization Plan

## Scope

- Resource level: heavy. The warehouse remains the authority for warehouse
  product identity, category, SKU, inventory, and sale state. The order system
  owns merchant sales presentation, price overrides, recommendations, archives,
  and buyer projections.
- Production is unchanged. The candidate must pass isolated Node 20/Linux
  validation, independent review, acceptance, and user preview approval before
  a deployment backup or any production change is created.
- Recovery source manifest: `.task-backups/20260819-product-archive-before/MANIFEST.sha256`.
  It contains source checksums only and no secrets, databases, media, or
  production data.

## Milestones

1. `in_progress` Reconcile the warehouse outbox, event hashing, projection
   acknowledgement, SKU lifecycle, and inventory reservation rules.
2. `in_progress` Complete order-side archive, deletion, restore, price
   override, recommendation, related-product, and stale-cart data rules.
3. `in_progress` Complete the administrator archive page and merchant/buyer
   detail behavior, including 15-second visibility-safe refreshes.
4. `in_progress` Source contracts, warehouse typecheck and cross-platform
   migration/rollback checks pass. Run real better-sqlite3 runtimes, builds
   and all 15 gates on Node 20/Linux, then create the isolated preview.
5. `pending` Obtain independent reviewer and acceptance reports, then provide
   an isolated preview for user approval.
6. `pending` Only after approval, create one recovery point, preserve the three
   existing production volumes, deploy, and perform post-cutover verification.

## Non-Negotiable Release Rules

- Never delete, recreate, or switch production data volumes.
- Never include `.env`, credentials, production databases, uploaded media, or
  archives in source packages, test output, status files, or backups.
- A failing health, projection, stock, or order-lifecycle check stops the
  release and retains the current mature deployment.
