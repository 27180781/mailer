-- InforU campaign ids (one per batch / group call), their totals, and sync bookkeeping
ALTER TABLE campaigns ADD COLUMN inforu_campaign_ids bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN inforu_stats jsonb;
ALTER TABLE campaigns ADD COLUMN inforu_stats_at timestamptz;
ALTER TABLE accounts ADD COLUMN inforu_unsub_last_id bigint;
ALTER TABLE accounts ADD COLUMN inforu_unsub_synced_at timestamptz;
CREATE INDEX messages_inforu_campaign ON messages (provider_message_id) WHERE provider = 'inforu';
