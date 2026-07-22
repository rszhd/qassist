const STATUS_COLORS = {
  queued: '#a16207',
  running: '#2563eb',
  passed: '#16a34a',
  failed: '#dc2626',
  error: '#dc2626',
  completed: '#4b5563',
  idle: '#6b7280',
};

// Shared header. It carries the run indicators even while the Library is open,
// so a run started in Run stays visible while you reorganize.
//
// The nav only appears once the control plane is up — with no DB there is no
// Library to open (US-023: nothing about grouping renders before it exists).
export default function TopBar({ view, setView, showNav, runState }) {
  const { status, wsState, runId } = runState;
  return (
    <header>
      <h1>QAssist <span className="tag">prototype</span></h1>
      {showNav && (
        <nav className="views">
          {['run', 'library'].map((v) => (
            <button
              key={v}
              type="button"
              className={v === view ? 'active' : ''}
              onClick={() => setView(v)}
            >
              {v === 'run' ? 'Run' : 'Library'}
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
        style={{ background: STATUS_COLORS[status] || '#6b7280' }}
      >
        {status}
      </span>
    </header>
  );
}
