-- Small system settings store (e.g. the Domain Connect signing key, generated once)
CREATE TABLE system_kv (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
