CREATE TABLE referral_request_resumes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES referral_requests(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/zip','application/octet-stream')),
  consented_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX referral_request_resumes_request_created ON referral_request_resumes(request_id,created_at DESC);
CREATE INDEX referral_request_resumes_candidate ON referral_request_resumes(candidate_id,request_id);
