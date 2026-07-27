// The run's step list, rendered the same way whether it is arriving live over
// the WebSocket (RunView) or read back from a finished run's artifacts
// (RunDetail, US-026) — one list, so what you watched and what you review
// later can't drift apart. Each view keeps its own empty state: "the first
// step lands shortly" and "no steps were recorded" are not the same thing.
//
// A step gets its screenshot here once US-020 lands.
export default function ActivityLog({ steps, logRef }) {
  // Newest first, so the step that just landed is the one you are already
  // looking at and a long run doesn't have to be scrolled to follow. Reversed
  // in the data rather than with `column-reverse`, so DOM order matches reading
  // order — a screen reader and a copy-paste follow the DOM, not the flexbox.
  // The pair keeps each step's arrival index as its key: a step arriving at the
  // top would otherwise shift every index below it and rewrite every row.
  const newestFirst = steps.map((s, i) => [i, s]).reverse();
  return (
    <div className="log" ref={logRef}>
      {newestFirst.map(([i, s]) => (
        <div className="log-item" key={i}>
          <span className="step-n">{marker(s)}</span>
          <span className="step-body">
            <span className="step-goal">{stepText(s)}</span>
            {s.url && <span className="step-url">{s.url}</span>}
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
