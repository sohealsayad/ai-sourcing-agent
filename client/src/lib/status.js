// Request statuses grouped for the dashboard filters and KPI cards. One source of truth so
// tab counts, KPI numbers and filtered rows always agree. NO_DEAL, CANCELLED and any unknown
// status belong to no group and only appear under "All".
export const STATUS_GROUPS = {
  active: ['DRAFT', 'DISCOVERING', 'SUPPLIERS_FOUND', 'SENDING_PROPOSALS', 'AWAITING_REPLIES', 'NEGOTIATING'],
  approval: ['DEAL_RECOMMENDED'],
  approved: ['CLOSED'],
  failed: ['FAILED'],
};

export const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'In progress' },
  { key: 'approval', label: 'Needs approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'failed', label: 'Failed' },
];

export const matchesStatusFilter = (status, key) => key === 'all' || (STATUS_GROUPS[key]?.includes(status) ?? false);
