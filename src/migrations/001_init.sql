CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Accounts (tenants). type=platform may create senders (sub-accounts) and use a fallback sender.
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL DEFAULT 'standard' CHECK (type IN ('standard', 'platform')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  daily_limit integer NOT NULL DEFAULT 200,
  monthly_limit integer,
  -- Legal footer details required for advertising mail (Israeli Communications Law section 30A)
  company_name text,
  company_address text,
  contact_email text,
  -- Platform fallback: used when a sender's domain is not verified
  fallback_from_email text,
  fallback_name_template text NOT NULL DEFAULT '{{name}} באמצעות {{account}}',
  track_transactional boolean NOT NULL DEFAULT false,
  paused_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Senders: sub-accounts of a platform account (e.g. each business in Retzef).
CREATE TABLE senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  external_id text,
  default_reply_to text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

-- A domain can be owned by exactly one account, so no tenant can send as another's domain.
CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES senders(id) ON DELETE CASCADE,
  name text NOT NULL UNIQUE,
  provider text NOT NULL,
  provider_data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'degraded')),
  dkim_status text NOT NULL DEFAULT 'pending',
  mail_from_domain text,
  mail_from_status text NOT NULL DEFAULT 'pending',
  dmarc_status text NOT NULL DEFAULT 'pending',
  dmarc_record text,
  records jsonb NOT NULL DEFAULT '[]',
  last_checked_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domains_account ON domains(account_id, sender_id);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  attributes jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unsubscribed', 'bounced', 'complained')),
  consent_source text,
  consent_at timestamptz,
  consent_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, email)
);

CREATE TABLE lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  double_opt_in boolean NOT NULL DEFAULT true,
  -- Sender used for double opt-in confirmation emails
  from_email text,
  from_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_members (
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  html text NOT NULL DEFAULT '',
  text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES senders(id) ON DELETE SET NULL,
  name text NOT NULL,
  subject text NOT NULL,
  from_name text NOT NULL,
  from_email text NOT NULL,
  reply_to text,
  html text NOT NULL DEFAULT '',
  text text,
  is_advertisement boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  paused_reason text,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_lists (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, list_id)
);

-- Every outgoing email, transactional or campaign. Doubles as the send queue.
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES senders(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('transactional', 'marketing', 'campaign')),
  priority smallint NOT NULL DEFAULT 0,
  to_email text NOT NULL,
  from_email text NOT NULL,
  from_name text,
  reply_to text,
  subject text,
  html text,
  text text,
  headers jsonb NOT NULL DEFAULT '{}',
  attachments jsonb,
  used_fallback boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  provider text,
  provider_message_id text,
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}',
  opened_at timestamptz,
  clicked_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX messages_queue ON messages(priority, next_attempt_at) WHERE status = 'queued';
CREATE INDEX messages_account_created ON messages(account_id, created_at);
CREATE INDEX messages_campaign ON messages(campaign_id, status);
CREATE INDEX messages_provider_id ON messages(provider_message_id);

-- Suppressions: account_id NULL = global (hard bounces). Unsubscribes and complaints are per account.
CREATE TABLE suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppressions_global ON suppressions(email) WHERE account_id IS NULL;
CREATE UNIQUE INDEX suppressions_account ON suppressions(account_id, email) WHERE account_id IS NOT NULL;

CREATE TABLE soft_bounces (
  email text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX soft_bounces_lookup ON soft_bounces(account_id, email, created_at);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_message ON events(message_id);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
