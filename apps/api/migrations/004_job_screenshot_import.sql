CREATE TABLE job_import_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','extracted','reviewing','published','discarded')),
  extracted_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extracted_json)),
  draft_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(draft_json)),
  external_processing_consent INTEGER NOT NULL DEFAULT 0 CHECK (external_processing_consent IN (0,1)),
  review_confirmed_at TEXT,
  published_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE job_import_images (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES job_import_drafts(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg')),
  sha256 TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  keep_until TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(draft_id,sort_order)
);

CREATE INDEX idx_job_import_owner ON job_import_drafts(owner_id,status,updated_at DESC);
CREATE INDEX idx_job_import_image_draft ON job_import_images(draft_id,sort_order);
CREATE INDEX idx_job_import_image_hash ON job_import_images(sha256);
CREATE INDEX idx_job_import_image_retention ON job_import_images(keep_until);

ALTER TABLE jobs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'employee' CHECK (source_type IN ('employee','screenshot_import'));
ALTER TABLE jobs ADD COLUMN source_import_id TEXT REFERENCES job_import_drafts(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN source_confirmed_at TEXT;
