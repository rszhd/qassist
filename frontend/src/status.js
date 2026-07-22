// Run status → colour, shared by the header badge, the history rows and the
// pass/fail timeline. One table so a verdict never reads as two different
// colours depending on where you are looking at it.
//
// These are solid fills behind white text, so they sit a shade darker than the
// text-weight --ok/--warn/--bad in App.css; keep the two in step when the
// palette changes.
export const STATUS_COLORS = {
  queued: '#a16207',
  running: '#5b5bd6',
  passed: '#1c9c62',
  failed: '#cf3b40',
  error: '#cf3b40',
  completed: '#3f3f46',
  idle: '#52525b',
};

export const statusColor = (status) => STATUS_COLORS[status] || '#52525b';

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
