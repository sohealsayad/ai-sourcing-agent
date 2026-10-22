-- Core schema for the sourcing workflow. Tables for later steps (messages, offers)
-- are created now so the data model is complete from the start.

CREATE TABLE IF NOT EXISTS sourcing_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity      TEXT NOT NULL,
  specifications TEXT,
  location       TEXT NOT NULL,
  quantity       NUMERIC(14, 2) NOT NULL CHECK (quantity > 0),
  unit           TEXT NOT NULL,
  target_price   NUMERIC(14, 2) NOT NULL CHECK (target_price > 0),
  max_price      NUMERIC(14, 2) CHECK (max_price IS NULL OR max_price >= target_price),
  currency       CHAR(3) NOT NULL DEFAULT 'USD',
  deadline       DATE,
  buyer_name     TEXT,
  buyer_email    TEXT,
  status         TEXT NOT NULL DEFAULT 'DRAFT',
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sourcing_requests_status ON sourcing_requests (status);
CREATE INDEX IF NOT EXISTS idx_sourcing_requests_created ON sourcing_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  website     TEXT,
  location    TEXT,
  description TEXT,
  source_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_email ON suppliers (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_website ON suppliers (lower(website));

-- One row per supplier contacted for a request; relevance is per request, not per supplier.
CREATE TABLE IF NOT EXISTS request_suppliers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID NOT NULL REFERENCES sourcing_requests (id) ON DELETE CASCADE,
  supplier_id         UUID NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  relevance_score     NUMERIC(5, 2),
  ai_reasoning        TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  current_offer_price NUMERIC(14, 2),
  rounds_used         INTEGER NOT NULL DEFAULT 0,
  last_contacted_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_request_suppliers_request ON request_suppliers (request_id);

CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_supplier_id UUID NOT NULL REFERENCES request_suppliers (id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  subject             TEXT,
  body                TEXT NOT NULL,
  parsed_json         JSONB,
  external_id         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (request_supplier_id, created_at);

CREATE TABLE IF NOT EXISTS offers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_supplier_id UUID NOT NULL REFERENCES request_suppliers (id) ON DELETE CASCADE,
  round               INTEGER NOT NULL,
  unit_price          NUMERIC(14, 2) NOT NULL,
  quantity            NUMERIC(14, 2),
  delivery_days       INTEGER,
  payment_terms       TEXT,
  valid_until         DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offers_thread ON offers (request_supplier_id, round);

-- Append-only audit log; drives the timeline in the UI.
CREATE TABLE IF NOT EXISTS workflow_events (
  id         BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES sourcing_requests (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_request ON workflow_events (request_id, id);
