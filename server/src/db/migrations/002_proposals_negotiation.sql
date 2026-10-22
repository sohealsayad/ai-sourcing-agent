-- Columns for proposals (outbox), negotiation and approval. Every statement is guarded
-- so the migration can be re-run safely.

ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS max_rounds INTEGER NOT NULL DEFAULT 3;
ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS recommendation JSONB;
ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS recommended_request_supplier_id UUID
  REFERENCES request_suppliers (id) ON DELETE SET NULL;
ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS approved_request_supplier_id UUID
  REFERENCES request_suppliers (id) ON DELETE SET NULL;
ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS selected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS rfq_ref TEXT;
ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS opening_price NUMERIC(14, 2);
ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS final_reason TEXT;
ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE request_suppliers ADD COLUMN IF NOT EXISTS sim_profile JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_request_suppliers_rfq_ref ON request_suppliers (rfq_ref) WHERE rfq_ref IS NOT NULL;

-- messages doubles as the outbox: outbound rows start PENDING and a job delivers them.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_email TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_email TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_idempotency_key ON messages (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_messages_pending_outbound ON messages (created_at)
  WHERE direction = 'outbound' AND delivery_status = 'PENDING';

ALTER TABLE offers ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages (id) ON DELETE SET NULL;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS currency CHAR(3);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS is_final BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_offers_message ON offers (message_id) WHERE message_id IS NOT NULL;
