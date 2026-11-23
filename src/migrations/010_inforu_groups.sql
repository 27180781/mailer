-- InforU campaigns can also target contact groups that live in InforU (sent by group id, not copied here)
ALTER TABLE campaigns ADD COLUMN inforu_groups jsonb NOT NULL DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN inforu_groups_sent_at timestamptz;
ALTER TABLE campaigns ADD COLUMN inforu_groups_request_id text;
