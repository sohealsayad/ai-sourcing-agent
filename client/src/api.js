export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.fields = body?.fields;
  }
}

const API_DOWN = 'Cannot reach the API server (port 4000). Is `npm run dev` running? Check its terminal for errors.';

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    throw new ApiError(0, { error: API_DOWN });
  }
  const body = await res.json().catch(() => null);
  // The API always answers with JSON; a non-JSON error comes from the Vite proxy when the API is down.
  if (!res.ok) throw new ApiError(res.status, body ?? { error: res.status >= 500 ? API_DOWN : undefined });
  return body;
}

const post = (path, data) => request(path, { method: 'POST', body: JSON.stringify(data ?? {}) });

export const api = {
  health: () => request('/health'),
  listRequests: () => request('/requests'),
  getRequest: (id) => request(`/requests/${id}`),
  createRequest: (data) => post('/requests', data),
  rediscover: (id) => post(`/requests/${id}/rediscover`),
  addSupplier: (id, supplier) => post(`/requests/${id}/suppliers`, supplier),
  listSuppliers: () => request('/suppliers'),
  listQuotes: () => request('/quotes'),
  listNegotiations: () => request('/negotiations'),
  recheckSupplier: (id, threadId) => post(`/requests/${id}/suppliers/${threadId}/recheck`),
  enterQuote: (id, threadId, quote) => post(`/requests/${id}/suppliers/${threadId}/quote`, quote),
  closeSupplier: (id, threadId) => post(`/requests/${id}/suppliers/${threadId}/close`),
  listAllowedRecipients: () => request('/email-allowlist'),
  allowRecipient: (email, requestId) => post('/email-allowlist', { email, ...(requestId && { requestId }) }),
  removeAllowedRecipient: (email) => request(`/email-allowlist/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  updateSupplierEmail: (id, threadId, email) =>
    request(`/requests/${id}/suppliers/${threadId}`, { method: 'PATCH', body: JSON.stringify({ email }) }),
  sendProposals: (id, requestSupplierIds) => post(`/requests/${id}/send-proposals`, requestSupplierIds ? { requestSupplierIds } : {}),
  approveDeal: (id, requestSupplierId, approvedBy) => post(`/requests/${id}/approve`, { requestSupplierId, approvedBy }),
  rejectDeals: (id, rejectedBy, reason) => post(`/requests/${id}/reject`, { rejectedBy, reason }),
};
