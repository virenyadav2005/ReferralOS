ALTER TABLE sessions ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
UPDATE sessions SET last_seen_at=created_at WHERE last_seen_at='';
CREATE INDEX idx_sessions_last_seen ON sessions(last_seen_at,user_id);
