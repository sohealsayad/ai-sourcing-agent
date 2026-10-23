-- Web search results of the current discovery, so a retry after an AI failure does not search
-- (and spend search credits) again. Cleared when the buyer asks to search again.
ALTER TABLE sourcing_requests ADD COLUMN IF NOT EXISTS discovery_cache jsonb;
