-- Accounts allowed to verify subdomains of reserved domains (e.g. mail.retsef.co.il for the Retzef platform account)
ALTER TABLE accounts ADD COLUMN can_use_reserved_domains boolean NOT NULL DEFAULT false;
