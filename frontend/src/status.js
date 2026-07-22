// Run status → colour, shared by the header badge, the history rows and the
// pass/fail timeline. One table so a verdict never reads as two different
// colours depending on where you are looking at it.
export const STATUS_COLORS = {
  queued: '#a16207',
  running: '#2563eb',
  passed: '#16a34a',
  failed: '#dc2626',
  error: '#dc2626',
  completed: '#4b5563',
  idle: '#6b7280',
};

export const statusColor = (status) => STATUS_COLORS[status] || '#6b7280';

/** Compact local timestamp for history rows — date and minute, no year. */
export function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Wall-clock run length; '—' until the run has both ends. */
export function formatDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '—';
  const secs = Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000);
  if (!Number.isFinite(secs) || secs < 0) return '—';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
