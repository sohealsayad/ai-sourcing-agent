-- Email addresses approved for real delivery from the UI, in addition to EMAIL_ALLOWED_RECIPIENTS.
CREATE TABLE IF NOT EXISTS email_allowlist (
  email      TEXT PRIMARY KEY,
  added_by   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
