import { statusColor, formatWhen, statusLabel } from './status.js';

// The pass/fail strip, oldest on the left. Lifted out of HistoryView (US-069)
// because a second one now hangs off each row of the Schedules page, and two
// strips that disagree about what red means is the bug this file exists to
// prevent — the same job `status.js` already does for the colours themselves.
//
// It takes *marks*, not runs: History's bar is one run, a schedule's bar is
// one slot that may hold ten of them, and the only thing the component needs
// to know about either is a colour, a tooltip and what a click means. The
// caller supplies them in display order, oldest first, so neither strip can
// acquire an opinion about ordering that the other does not share.

/**
 * @typedef {{ key: string, color: string, title: string }} Mark
 */

/**
 * @param {{ marks: Mark[], caption?: string, endLabel?: string,
 *           onPick?: (key: string) => void, selectedKey?: string | null }} props
 */
export default function Timeline({ marks, caption, endLabel, onPick, selectedKey }) {
  // Nothing to chart draws nothing, not an empty frame: a schedule that has
  // not run yet and one whose runs predate the attribution columns both land
  // here, and an empty strip would read as "ran and produced no verdicts".
  if (!marks.length) return null;

  return (
    <div className="timeline">
      {caption && <span className="timeline-rate">{caption}</span>}
      {/* One end label, not two: the bars run oldest to newest and only the
          newest end is worth naming. Optional — in a list row there is no space
          for it, and every bar's tooltip names its own slot. */}
      <span className="timeline-chart">
        <span className="timeline-bars">
          {marks.map((mark) => (
            <button
              key={mark.key}
              type="button"
              className={`tl-bar${mark.key === selectedKey ? ' active' : ''}`}
              style={{ background: mark.color }}
              title={mark.title}
              onClick={onPick ? () => onPick(mark.key) : undefined}
            />
          ))}
        </span>
        {endLabel && <span className="timeline-scale">{endLabel}</span>}
      </span>
    </div>
  );
}

/**
 * History's marks: one run per bar, from the page the list is already showing.
 * Charting the listed runs rather than fetching its own window is what keeps
 * the strip and the list from ever disagreeing.
 */
export function runMarks(runs) {
  return [...runs]
    .reverse()
    .map((run) => ({
      key: run.id,
      color: statusColor(run.status),
      title: `${formatWhen(run.created_at)} — ${statusLabel(run.status)}`,
    }));
}

/**
 * A schedule's marks: one bar per firing, from the `recent` array the list
 * route collapses (US-069). A ten-test suite is one bar, so it cannot
 * out-weigh a one-test schedule in a strip of the same width.
 */
export function slotMarks(recent) {
  return [...recent].reverse().map((slot) => ({
    key: slot.scheduled_for,
    color: statusColor(slot.status),
    title: slotTitle(slot),
  }));
}

function slotTitle({ scheduled_for, status, runs, failed }) {
  const when = formatWhen(scheduled_for);
  // The failure count leads when there is one: "3 of 8 failed" is what the
  // reader came for, and "failed" alone hides whether it was one member or all
  // of them.
  if (failed) return `${when} — ${failed} of ${runs} failed`;
  return `${when} — ${runs === 1 ? '1 run' : `${runs} runs`}, ${statusLabel(status)}`;
}

/** The caption above a schedule's strip: how its charted slots turned out. */
export function slotCaption(recent) {
  const passed = recent.filter((s) => s.status === 'passed').length;
  return `${passed}/${recent.length} ${recent.length === 1 ? 'slot' : 'slots'} passed`;
}
