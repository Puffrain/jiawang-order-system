-- Keep the user-facing pipeline stage separate from queue/lease status.
ALTER TABLE import_jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued'
  CHECK (stage IN ('queued','unpacking','preprocessing','classifying','grouping','extracting','review_pending','completed','failed'));
