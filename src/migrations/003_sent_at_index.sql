-- Rolling 24h count of sent messages, for the system-wide daily cap
CREATE INDEX messages_sent_at ON messages(sent_at) WHERE sent_at IS NOT NULL;
