// The run's step list, rendered the same way whether it is arriving live over
// the WebSocket (RunView) or read back from a finished run's artifacts
// (RunDetail, US-026) — one list, so what you watched and what you review
// later can't drift apart. Each view keeps its own empty state: "the first
// step lands shortly" and "no steps were recorded" are not the same thing.
//
// A step gets its screenshot here once US-020 lands.
export default function ActivityLog({ steps, logRef, live }) {
  // Newest first, so the step that just landed is the one you are already
  // looking at and a long run doesn't have to be scrolled to follow. Reversed
  // in the data rather than with `column-reverse`, so DOM order matches reading
  // order — a screen reader and a copy-paste follow the DOM, not the flexbox.
  // The pair keeps each step's arrival index as its key: a step arriving at the
  // top would otherwise shift every index below it and rewrite every row.
  const newestFirst = steps.map((s, i) => [i, s]).reverse();
  return (
    <div className="log" ref={logRef}>
      {newestFirst.map(([i, s], row) => (
        <div className="log-item" key={i}>
          {/* While the run is live the newest row IS the current action — the
              agent announces a step as it starts it — so the pulse marks it in
              place of its number. A separate "current action" line above the
              log said the same sentence twice: `stepText` below and the state
              that fed that line read the same fields off the same event. */}
          {live && row === 0
            ? <span className="pulse" role="img" aria-label="in progress" />
            : <span className="step-n">{marker(s)}</span>}
          <span className="step-body">
            <span className="step-goal">{stepText(s)}</span>
            {/* One line, clamped in CSS — `title` is how the rest of a long
                URL is recovered. */}
            {s.url && <span className="step-url" title={s.url}>{s.url}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A step's number, or a glyph for the two events that have none. */
function marker(s) {
  if (s.type === 'blocked') return '⊘';
  if (s.type === 'progress') return '···';
  return s.step;
}

/** What a step event says it is doing — `progress` events carry a message. */
function stepText(s) {
  if (s.type === 'blocked') return 'Blocked by this instance — navigation refused';
  return s.message || s.next_goal || s.thinking || s.evaluation || '…';
}
