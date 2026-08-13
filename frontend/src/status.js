// Run status → colour, for the pass/fail timeline bars. One table so a verdict
// never reads as two different colours depending on where you are looking at
// it — the history rows carried these as dots until they took the pill.
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
  // US-047. Its own colour rather than `completed`'s grey: both ended without a
  // verdict, but one ran out of goal and the other was stopped by hand, and on
  // the timeline the colour is the only thing telling them apart.
  cancelled: 'var(--fill-cancelled)',
  idle: 'var(--fill-idle)',
};

export const statusColor = (status) => STATUS_COLORS[status] || 'var(--fill-idle)';

// The word a status is shown as, where it differs from the word the API uses.
// `cancelled` is the column value — the check constraint, the ?status= filter,
// CI's branch — but the product calls the act "stop" everywhere a person meets
// it, and a CANCELLED badge under a Stop button is two names for one thing.
// The report mail already made this choice (notify.js maps it to STOPPED).
const STATUS_LABELS = { cancelled: 'stopped' };

export const statusLabel = (status) => STATUS_LABELS[status] || status;

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

/**
 * A promised time, in the reader's own words and their own timezone —
 * "Mon 27 Jul, 14:20". Longer than formatWhen on purpose: this is a commitment
 * being made to a customer (US-054's activation window), not a log line, and
 * the weekday is what makes "tomorrow afternoon" legible at a glance.
 */
export function formatDeadline(iso) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
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

// A run's cost runs from a few dollars down to fractions of a cent, so a fixed
// two decimals would print $0.00 over a real charge — this story's failure mode
// reached by rounding rather than by a missing flag. Three decimals under a
// dollar, and an amount too small even for those says so instead of collapsing
// to nothing. A zero here has already been established as a measured one, and a
// genuinely free model is entitled to read as free.
function money(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (n >= 1) return `$${n.toFixed(2)}`;
  return n < 0.001 ? '< $0.001' : `$${n.toFixed(3)}`;
}

/**
 * What a run spent (US-046), decided by `cost_known` and never by the number.
 * browser-use reports 0.0 when costing was switched off, when the pricing table
 * never loaded and when the model has no published price, so only a known zero
 * means the run was free.
 *
 * The two ways of not knowing are worth separating: 'Unknown' is a run that was
 * measured and could not be priced, '—' is a run nothing measured — one still
 * going, or one from before this shipped. Neither is ever '$0.00'.
 *
 * No view calls this today: the estimate is off the UI until the arithmetic
 * behind it is trusted. The API still carries the figure, so putting the stat
 * back is one line in RunView and RunDetail.
 *
 * @param {number|null|undefined} cost
 * @param {boolean|undefined} known
 * @param {number|null|undefined} tokens what the run counted, which is what
 *   separates "no price" from "no measurement"
 */
export function formatCost(cost, known, tokens) {
  if (known && cost != null) return money(cost);
  return tokens == null ? '—' : 'Unknown';
}

/** A token count with the reader's own thousands separator; '—' if uncounted. */
export function formatTokens(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}
