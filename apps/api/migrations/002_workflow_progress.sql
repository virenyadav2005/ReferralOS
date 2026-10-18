CREATE TABLE workflow_step_completions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES job_workflow_steps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completion_state TEXT NOT NULL CHECK (completion_state IN ('candidate_reported','employee_confirmed')),
  application_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(step_id,user_id)
);
CREATE INDEX idx_workflow_completions_user_job ON workflow_step_completions(user_id,job_id,created_at);
