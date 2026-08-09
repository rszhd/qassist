// What the browser said while the run was failing (US-044): failed requests,
// console errors and uncaught exceptions, grouped under the step they happened
// during. The agent has already scrubbed, capped and deduplicated these — this
// view only decides how they read.
//
// Grouped here rather than server-side because the API returns one flat list: a
// finding can predate the first step (a page's own assets failing to load do),
// and those lead — the page was already broken before the agent touched it.
//
// `onSeek` and `stepSeconds` are how a group reaches the recording (US-078),
// on the same terms a step row gets it: the caller passes them only where a
// player exists. The heading is the target and not the row, because a finding
// is deduplicated with a `count` — an entry reading `12×` stands for twelve
// moments and owns none of them, and the step it is attributed to is the only
// well-defined time it has.
export default function Diagnostics({ diagnostics, dropped = 0, onSeek, stepSeconds }) {
  return (
    <div className="diag">
      {groupByStep(diagnostics).map(([step, entries]) => {
        // The stepless group is the page's own load, which is the head of the
        // recording by definition — it needs no map entry.
        const seconds = step === null ? 0 : stepSeconds?.get(step);
        const seek = onSeek && seconds != null ? () => onSeek(seconds) : null;
        // Same rule as a step row: a button only where it seeks, so the
        // keyboard and a screen reader get the affordance for free and nothing
        // else swallows a click.
        const Head = seek ? 'button' : 'div';
        return (
          <div className="diag-group" key={step ?? 'pre'}>
            <Head
              className="diag-step"
              {...(seek && { type: 'button', onClick: seek, title: 'Show this step in the recording' })}
            >
              {step === null ? 'Before the first step' : `Step ${step}`}
            </Head>
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
        );
      })}
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
