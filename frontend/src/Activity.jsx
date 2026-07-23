// The run's step list, rendered the same way whether it is arriving live over
// the WebSocket (RunView) or read back from a finished run's artifacts
// (RunDetail, US-026) — one list, so what you watched and what you review
// later can't drift apart. Each view keeps its own empty state: "the first
// step lands shortly" and "no steps were recorded" are not the same thing.
//
// A step gets its screenshot here once US-020 lands.
export default function ActivityLog({ steps, logRef }) {
  return (
    <div className="log" ref={logRef}>
      {steps.map((s, i) => (
        <div className="log-item" key={i}>
          <span className="step-n">{s.type === 'progress' ? '···' : s.step}</span>
          <span className="step-body">
            <span className="step-goal">{stepText(s)}</span>
            {s.url && <span className="step-url">{s.url}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** What a step event says it is doing — `progress` events carry a message. */
function stepText(s) {
  return s.message || s.next_goal || s.thinking || s.evaluation || '…';
}
