-- Optional second channel for campaigns: InforUMobile (uses the account's own InforU mail packages)
ALTER TABLE campaigns ADD COLUMN channel text NOT NULL DEFAULT 'ses' CHECK (channel IN ('ses', 'inforu'));
ALTER TABLE accounts ADD COLUMN inforu_username text;
-- AES-256-GCM with a key derived from APP_SECRET; never returned by the API
ALTER TABLE accounts ADD COLUMN inforu_token_enc text;
CREATE INDEX messages_queued_campaign ON messages (campaign_id) WHERE status = 'queued' AND campaign_id IS NOT NULL;
