// Whether an offer came from the supplier's own email or was typed in by the buyer.
// Needs `messages m` joined on o.message_id.
export const OFFER_SOURCE_SQL = `CASE WHEN m.parsed_json->>'manual' = 'true' THEN 'manual' ELSE 'supplier' END`;
