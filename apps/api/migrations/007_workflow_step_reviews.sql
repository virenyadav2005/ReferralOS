ALTER TABLE workflow_step_completions ADD COLUMN request_id TEXT REFERENCES referral_requests(id) ON DELETE CASCADE;
ALTER TABLE workflow_step_completions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending_review'
  CHECK (review_status IN ('pending_review','approved','changes_requested','resubmitted'));
ALTER TABLE workflow_step_completions ADD COLUMN employee_response TEXT;
ALTER TABLE workflow_step_completions ADD COLUMN reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workflow_step_completions ADD COLUMN reviewed_at TEXT;
ALTER TABLE workflow_step_completions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow_step_completions ADD COLUMN submitted_at TEXT NOT NULL DEFAULT '';

UPDATE workflow_step_completions
SET request_id=(SELECT r.id FROM referral_requests r WHERE r.job_id=workflow_step_completions.job_id
  AND r.candidate_id=workflow_step_completions.user_id LIMIT 1),
  review_status=CASE WHEN completion_state='employee_confirmed' THEN 'approved' ELSE 'pending_review' END,
  updated_at=created_at,submitted_at=created_at;

CREATE INDEX idx_workflow_completions_request ON workflow_step_completions(request_id,step_id);

CREATE TABLE workflow_step_review_history (
  id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL REFERENCES workflow_step_completions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES referral_requests(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES job_workflow_steps(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('submitted','approved','changes_requested','resubmitted')),
  status TEXT NOT NULL CHECK (status IN ('pending_review','approved','changes_requested','resubmitted')),
  submitted_information TEXT,
  employee_response TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_workflow_review_history_request ON workflow_step_review_history(request_id,step_id,created_at,id);

INSERT INTO workflow_step_review_history(id,completion_id,request_id,step_id,actor_id,action,status,submitted_information,created_at)
SELECT lower(hex(randomblob(16))),wc.id,wc.request_id,wc.step_id,wc.user_id,'submitted','pending_review',wc.note,wc.created_at
FROM workflow_step_completions wc WHERE wc.request_id IS NOT NULL AND wc.completion_state='candidate_reported';
