-- requires_foreign_keys_off
-- Rebuild the two CHECK-constrained tables without dropping data. Child tables
-- retain their references to the final jobs/referral_requests names.

CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  posted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  location_type TEXT NOT NULL CHECK (location_type IN ('remote','hybrid','onsite')),
  experience_level TEXT NOT NULL CHECK (experience_level IN ('intern','entry','mid','senior','lead','executive')),
  employment_type TEXT NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time','contract','internship')),
  skills_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skills_json)),
  salary_range TEXT,
  source_url TEXT,
  workflow_template TEXT NOT NULL CHECK (workflow_template IN ('direct_referral_link','apply_first','request_employee','referral_form','email_instructions','custom')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','paused','closed','expired','removed')),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO jobs_new SELECT id,company_id,posted_by,title,description,location,location_type,experience_level,employment_type,
  skills_json,salary_range,source_url,workflow_template,status,is_demo,expires_at,created_at,updated_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE TABLE referral_requests_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message TEXT,
  application_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','candidate_action_needed','employee_action_needed','referral_confirmed','candidate_reported_applied','withdrawn','closed','expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(job_id, candidate_id)
);
INSERT INTO referral_requests_new SELECT id,job_id,candidate_id,employee_id,message,application_id,status,created_at,updated_at FROM referral_requests;
DROP TABLE referral_requests;
ALTER TABLE referral_requests_new RENAME TO referral_requests;

ALTER TABLE employee_affiliations ADD COLUMN work_email_verified_at TEXT;
ALTER TABLE employee_affiliations ADD COLUMN work_email_domain TEXT;

CREATE TABLE employee_email_verifications (
  id TEXT PRIMARY KEY,
  affiliation_id TEXT NOT NULL REFERENCES employee_affiliations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE referral_request_messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES referral_requests(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  audience TEXT NOT NULL DEFAULT 'participants' CHECK (audience IN ('participants','employee_private')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT
);

CREATE INDEX idx_jobs_public_created ON jobs(status, expires_at, created_at DESC);
CREATE INDEX idx_jobs_company ON jobs(company_id, status, created_at DESC);
CREATE INDEX idx_jobs_poster ON jobs(posted_by, created_at DESC);
CREATE INDEX idx_requests_candidate ON referral_requests(candidate_id, created_at DESC);
CREATE INDEX idx_requests_employee ON referral_requests(employee_id, status, created_at DESC);
CREATE INDEX idx_employee_email_verifications_latest ON employee_email_verifications(affiliation_id, created_at DESC);
CREATE INDEX idx_request_messages_request ON referral_request_messages(request_id, created_at);
CREATE INDEX idx_contact_messages_status ON contact_messages(status,created_at DESC);

