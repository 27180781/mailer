-- Threading, CC/BCC, test mode
ALTER TABLE messages
  ADD COLUMN message_id_header text,
  ADD COLUMN to_list text[] NOT NULL DEFAULT '{}',
  ADD COLUMN cc text[] NOT NULL DEFAULT '{}',
  ADD COLUMN bcc text[] NOT NULL DEFAULT '{}',
  ADD COLUMN test boolean NOT NULL DEFAULT false;

-- One row per recipient for messages with CC/BCC (a single MIME message to several people)
CREATE TABLE message_recipients (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  email text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  status text NOT NULL DEFAULT 'queued',
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, email)
);

ALTER TABLE api_keys ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test'));

-- BIMI (sender logo)
ALTER TABLE domains
  ADD COLUMN bimi_svg text,
  ADD COLUMN bimi_certificate text;

-- Automatic, gradual trust
ALTER TABLE accounts
  ADD COLUMN trust_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN trust_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN trust_manual boolean NOT NULL DEFAULT false;
UPDATE accounts SET trust_level = 1 WHERE status = 'active';
