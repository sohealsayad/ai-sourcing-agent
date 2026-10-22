-- Remembers which messages an inbox poller has already handed to the workflow.
CREATE TABLE IF NOT EXISTS inbound_cursor (
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  matched     BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id)
);
