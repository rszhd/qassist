import { useEffect, useState } from 'react';
import HistoryView from './HistoryView.jsx';
import LibraryView from './LibraryView.jsx';
import RunView from './RunView.jsx';
import TopBar from './TopBar.jsx';
import { Button, Field, Modal } from './ui.jsx';

// Shell: owns only what every view needs (the API token, server health, which
// view is open). Each view owns its own data and fetches it when it mounts.
export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem('qassist_token') || localStorage.getItem('qagent_token') || ''
  );
  const [health, setHealth] = useState(null);
  const [view, setView] = useState('run');
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // The token is a deployment detail, not part of running a test, so it lives
  // behind the gear rather than in the run form.
  const needsToken = (!health || health.auth) && !token;

  return (
    <>
      <TopBar
        view={view}
        setView={setView}
        showNav={!!health?.db}
        runState={runState}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="app">
        {/* Run stays mounted while hidden: unmounting would drop the live
            WebSocket and the finished run's result. Library and History are
            cheap to remount, and remounting is what refreshes them — History
            in particular should show the run you just watched finish. */}
        <div hidden={view !== 'run'}>
          <RunView
            token={token}
            health={health}
            visible={view === 'run'}
            needsToken={needsToken}
            onOpenSettings={() => setSettingsOpen(true)}
            onRunState={setRunState}
          />
        </div>
        {view === 'history' && <HistoryView token={token} />}
        {view === 'library' && <LibraryView token={token} />}
      </div>

      {settingsOpen && (
        <Modal
          title="Settings"
          description="Stored in this browser only — nothing is sent anywhere but your worker."
          onClose={() => setSettingsOpen(false)}
          footer={<Button variant="primary" onClick={() => setSettingsOpen(false)}>Done</Button>}
        >
          <Field
            label="API token"
            hint="The worker's WORKER_API_TOKEN. Required on every API and WebSocket call."
          >
            <input
              type="password"
              value={token}
              placeholder="WORKER_API_TOKEN"
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          {health && (
            <dl className="detail-facts">
              <dt>Agent</dt>
              <dd>{health.agent_ready ? 'Ready' : 'No OPENAI_API_KEY on the server'}</dd>
              <dt>Control plane</dt>
              <dd>{health.db ? 'Connected' : 'Not configured — saved tests and history are off'}</dd>
              <dt>Auth</dt>
              <dd>{health.auth ? 'Token required' : 'Open (no token configured)'}</dd>
            </dl>
          )}
        </Modal>
      )}
    </>
  );
}
