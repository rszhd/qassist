import { useEffect, useState } from 'react';
import LibraryView from './LibraryView.jsx';
import RunView from './RunView.jsx';
import TopBar from './TopBar.jsx';

// Shell: owns only what every view needs (the API token, server health, which
// view is open). Each view owns its own data and fetches it when it mounts.
export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem('qassist_token') || localStorage.getItem('qagent_token') || ''
  );
  const [health, setHealth] = useState(null);
  const [view, setView] = useState('run');
  // Mirrored up from RunView so the header can show it from either view.
  const [runState, setRunState] = useState({ status: 'idle', wsState: 'idle', runId: null });

  useEffect(() => {
    localStorage.setItem('qassist_token', token);
  }, [token]);

  // /api/health is unauthenticated — it tells us whether a token is even
  // needed (auth), whether runs can work at all (agent_ready) and whether the
  // control plane is up (db).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => !cancelled && setHealth(h))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <TopBar view={view} setView={setView} showNav={!!health?.db} runState={runState} />
      {/* Run stays mounted while hidden: unmounting would drop the live
          WebSocket and the finished run's result. Library is cheap to remount,
          and remounting is what refreshes it after edits made elsewhere. */}
      <div hidden={view !== 'run'}>
        <RunView
          token={token}
          setToken={setToken}
          health={health}
          visible={view === 'run'}
          onRunState={setRunState}
        />
      </div>
      {view === 'library' && <LibraryView token={token} />}
    </div>
  );
}
