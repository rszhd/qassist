// Run status → colour, shared by the history row dots and the pass/fail
// timeline bars. One table so a verdict never reads as two different colours
// depending on where you are looking at it.
//
// These are solid fills on a dark surface, so they run a shade brighter than
// the surface-weight --ok/--warn/--bad in App.css but stay at the same low
// saturation; keep the two in step when the palette changes. The status pill
// itself is CSS (`.badge-<status>`), not one of these.
export const STATUS_COLORS = {
  queued: '#9c8039',
  running: '#4d7cf6',
  passed: '#4cb98a',
  failed: '#d0666c',
  error: '#d0666c',
  completed: '#45454c',
  idle: '#4f4f57',
};

export const statusColor = (status) => STATUS_COLORS[status] || '#4f4f57';

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
