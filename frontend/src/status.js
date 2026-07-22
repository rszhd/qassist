// Run status → colour, shared by the history row dots and the pass/fail
// timeline bars. One table so a verdict never reads as two different colours
// depending on where you are looking at it.
//
// The values are `--fill-*` tokens rather than hexes: these are solid fills
// and the surface under them changes with the theme, so the palette has to
// stay in one place. That place is the token block at the top of App.css —
// swap it and the dots follow, which they could not do while this file held
// literals. The status pill itself is CSS (`.badge-<status>`), not one of
// these; the two live side by side in App.css so they stay in step.
export const STATUS_COLORS = {
  queued: 'var(--fill-queued)',
  running: 'var(--fill-running)',
  passed: 'var(--fill-passed)',
  failed: 'var(--fill-failed)',
  error: 'var(--fill-error)',
  completed: 'var(--fill-completed)',
  idle: 'var(--fill-idle)',
};

export const statusColor = (status) => STATUS_COLORS[status] || 'var(--fill-idle)';

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
