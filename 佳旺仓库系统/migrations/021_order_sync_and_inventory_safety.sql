-- Upgrade databases that already applied 018. Rebuilding preserves every
-- historical row while adding deterministic delivery and media metadata.
ALTER TABLE order_sync_outbox RENAME TO order_sync_outbox_legacy;

CREATE TABLE order_sync_outbox (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  event_type TEXT,
  media_revision INTEGER CHECK(media_revision IS NULL OR media_revision > 0),
  payload_hash TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','dead','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  delivered_at TEXT,
  superseded_at TEXT,
  claim_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, revision)
);

INSERT INTO order_sync_outbox (id,product_id,revision,event_type,payload_hash,payload_json,status,attempt_count,next_attempt_at,last_error,delivered_at,superseded_at,created_at,updated_at)
SELECT id,product_id,revision,event_type,payload_hash,payload_json,status,attempt_count,next_attempt_at,last_error,delivered_at,superseded_at,created_at,updated_at
FROM order_sync_outbox_legacy;

DROP TABLE order_sync_outbox_legacy;
CREATE INDEX idx_order_sync_due ON order_sync_outbox(status,next_attempt_at);
CREATE INDEX idx_order_sync_product_revision ON order_sync_outbox(product_id,revision DESC);

-- Publish history is independent from the current status. It prevents a
-- previously saleable warehouse product from being hard-deleted.
ALTER TABLE products ADD COLUMN ever_published_at TEXT;
ALTER TABLE products ADD COLUMN archived_at TEXT;
UPDATE products SET ever_published_at=published_at
WHERE ever_published_at IS NULL AND published_at IS NOT NULL;
UPDATE products SET ever_published_at=(
  SELECT MIN(created_at) FROM review_decisions
  WHERE review_decisions.product_id=products.id AND review_decisions.decision='approve'
)
WHERE ever_published_at IS NULL
  AND EXISTS (SELECT 1 FROM review_decisions WHERE review_decisions.product_id=products.id AND review_decisions.decision='approve');
-- A legacy outbox can prove publication even when review history was pruned.
-- Extract only from a CASE-guarded JSON value; migration must not rely on
-- SQLite's optimizer preserving AND predicate evaluation order.
UPDATE products SET ever_published_at=(
  SELECT MIN(created_at) FROM (
    SELECT created_at,
      CASE WHEN json_valid(payload_json)=1 THEN json_extract(payload_json, '$.status') END AS legacy_status
    FROM order_sync_outbox
    WHERE product_id=products.id
  )
  WHERE legacy_status='published'
)
WHERE ever_published_at IS NULL
  AND EXISTS (SELECT 1 FROM order_sync_outbox WHERE product_id=products.id
    AND CASE WHEN json_valid(payload_json)=1 THEN json_extract(payload_json, '$.status') END='published');
CREATE INDEX idx_products_live_status ON products(archived_at,status,updated_at DESC);

-- Removed SKUs remain addressable for releasing prior reservations, while
-- normal catalog reads and all new reservations exclude them.
ALTER TABLE product_variants ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_variants_product_live ON product_variants(product_id,deleted_at);

-- Reserve/release remain paired by the existing unique (order_id, kind)
-- ledger. These indexes keep idempotent lookup and compensation bounded.
CREATE INDEX idx_inventory_operations_order_kind ON inventory_operations(order_id,kind);
CREATE INDEX idx_inventory_operations_related ON inventory_operations(related_operation_id);
