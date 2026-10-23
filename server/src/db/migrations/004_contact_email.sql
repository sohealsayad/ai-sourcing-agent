-- A per-request email for a supplier (e.g. a test inbox for a supplier found without one).
-- Overrides suppliers.email for this request only; other requests keep the shared address.
ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS contact_email TEXT;
