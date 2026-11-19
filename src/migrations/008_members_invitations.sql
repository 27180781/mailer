-- One user can belong to several accounts (businesses), each with a role.
CREATE TABLE account_members (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_members_user_idx ON account_members (user_id);

INSERT INTO account_members (account_id, user_id, role)
SELECT account_id, id, CASE WHEN role = 'owner' THEN 'owner' ELSE 'editor' END FROM users WHERE account_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- users.account_id is now the last account the user worked in. Deleting an account no longer deletes its users.
ALTER TABLE users ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
-- How many businesses this user may own (NULL = MAX_ACCOUNTS_PER_USER)
ALTER TABLE users ADD COLUMN max_owned_accounts int;

-- The account a UI session is working in
ALTER TABLE sessions ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

CREATE TABLE account_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_invitations_open_idx ON account_invitations (account_id, email) WHERE accepted_at IS NULL;
