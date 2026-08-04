// @ts-check
// US-069: one slot, one bar. A schedule's firing can hold ten runs — a suite
// fires one per member — and the strip draws it as a single mark, so several
// run statuses have to become one colour.
//
// This adds no new run states. Every value returned here is one `runs.status`
// already renders elsewhere, and `status.js` on the client turns it into the
// same colour it uses for a single run. The only new thing is the rule.
//
// The rule is written as data because every wrong answer fails in the same
// direction — **green**. A slot of nine passes and one error reading green is a
// false all-clear on the page whose whole purpose is to raise the alarm, and
// nothing downstream contradicts it: no test fails, no other view disagrees,
// and the reader's conclusion is "fine".

/**
 * Severity, worst first. The first status present in a slot's members is the
 * slot's verdict, so reordering this array is the whole behaviour change.
 *
 * Why this order:
 * - `error` and `failed` are outcomes, and they outrank anything unfinished: a
 *   slot with one failure and one member still going has already failed, and
 *   waiting for the rest cannot make it green.
 * - `running` and `queued` outrank `cancelled` and `completed` because those
 *   two read as settled. An unfinished slot must not be given a final-looking
 *   answer — "still going" is the honest one, and it is not green.
 * - `passed` is last, so green requires **every** member to have passed.
 *
 * `success` is not consulted. `verdict.js` already crossed status with it when
 * it wrote the row — a run with no verdict is `completed`, never `passed` —
 * so reading both here would be re-deciding a question that is already
 * answered, in a second place that can drift from the first.
 */
export const SLOT_PRECEDENCE = [
  'error',
  'failed',
  'running',
  'queued',
  'cancelled',
  'completed',
  'passed',
];

/**
 * One slot's colour, from the statuses of the runs it started.
 * @param {string[]} statuses
 * @returns {string} a `runs.status` value
 */
export function slotVerdict(statuses) {
  // A status this table has never heard of sorts worst, and so does a slot
  // with no members at all. Both are unreachable from the strip's query today
  // — it groups rows that exist, over a column with a check constraint — and
  // both are loud rather than green on purpose: the next status added to the
  // constraint should announce itself here, not quietly join the passes.
  if (!statuses.length || statuses.some((s) => !SLOT_PRECEDENCE.includes(s))) return 'error';
  return SLOT_PRECEDENCE.find((candidate) => statuses.includes(candidate)) || 'error';
}
