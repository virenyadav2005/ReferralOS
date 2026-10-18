CREATE TABLE referral_message_reads (
  message_id TEXT NOT NULL REFERENCES referral_request_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT,
  PRIMARY KEY(message_id,user_id)
);
CREATE INDEX idx_message_reads_user_unread ON referral_message_reads(user_id,read_at,message_id);
