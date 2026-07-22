import { statusColor } from './status.js';

const VIEWS = [
  ['run', 'Run'],
  ['history', 'History'],
  ['library', 'Library'],
];

// Shared header. It carries the run indicators even while another view is
// open, so a run started in Run stays visible while you browse history or
// reorganize.
//
// The nav only appears once the control plane is up — with no DB there is no
// Library to open and no history to browse (US-023: nothing about grouping
// renders before it exists).
export default function TopBar({ view, setView, showNav, runState }) {
  const { status, wsState, runId } = runState;
  return (
    <header>
      <h1>QAssist <span className="tag">prototype</span></h1>
      {showNav && (
        <nav className="views">
          {VIEWS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={v === view ? 'active' : ''}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {runId && (
        <span className={`ws ws-${wsState}`}>
          ● {wsState === 'live' ? 'live' : wsState}
        </span>
      )}
      <span
        className={`badge${runId ? '' : ' badge-lead'}`}
        style={{ background: statusColor(status) }}
      >
        {status}
      </span>
    </header>
  );
}
