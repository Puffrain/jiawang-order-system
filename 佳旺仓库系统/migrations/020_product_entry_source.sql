ALTER TABLE products ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (entry_source IN ('manual', 'ai'));

UPDATE products
SET entry_source = 'ai'
WHERE source_group_id IS NOT NULL;
