// What the browser said while the run was failing (US-044): failed requests,
// console errors and uncaught exceptions, grouped under the step they happened
// during. The agent has already scrubbed, capped and deduplicated these — this
// view only decides how they read.
//
// Grouped here rather than server-side because the API returns one flat list: a
// finding can predate the first step (a page's own assets failing to load do),
// and those lead — the page was already broken before the agent touched it.
export default function Diagnostics({ diagnostics, dropped = 0 }) {
  return (
    <div className="diag">
      {groupByStep(diagnostics).map(([step, entries]) => (
        <div className="diag-group" key={step ?? 'pre'}>
          <div className="diag-step">{step === null ? 'Before the first step' : `Step ${step}`}</div>
          {entries.map((entry, i) => (
            <div className="diag-row" key={i}>
              <span className={`diag-tag${entry.level === 'warning' ? ' diag-warn' : ''}`}>
                {label(entry)}
              </span>
              <span className="diag-detail">{detail(entry)}</span>
              {entry.count > 1 && <span className="diag-count">{entry.count}×</span>}
            </div>
          ))}
        </div>
      ))}
      {dropped > 0 && (
        <p className="hint">
          A further {dropped} distinct {dropped === 1 ? 'finding' : 'findings'} exceeded the
          per-step capture limit and were counted but not recorded.
        </p>
      )}
    </div>
  );
}

/** `[[step, entries], …]`, stepless findings first, then in step order. */
function groupByStep(diagnostics) {
  const groups = new Map();
  for (const entry of diagnostics || []) {
    const step = Number.isInteger(entry.step) ? entry.step : null;
    if (!groups.has(step)) groups.set(step, []);
    groups.get(step).push(entry);
  }
  // null sorts first; -1 stands in for it as a sort key only.
  return [...groups.entries()].sort((a, b) => (a[0] ?? -1) - (b[0] ?? -1));
}

/** The short tag a finding reads under: its status code, or its kind. */
function label(entry) {
  if (entry.kind === 'request') return Number.isInteger(entry.status) ? entry.status : 'Failed';
  if (entry.kind === 'console') return entry.level === 'warning' ? 'Warn' : 'Error';
  if (entry.kind === 'exception') return 'Uncaught';
  return '—';
}

/** The finding itself: the URL that failed and why, or the message. */
function detail(entry) {
  if (entry.kind !== 'request') return entry.text || '';
  return entry.error ? `${entry.url || ''} — ${entry.error}` : entry.url || '';
}
