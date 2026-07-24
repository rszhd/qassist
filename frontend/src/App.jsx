import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import HistoryView from './HistoryView.jsx';
import Login from './Login.jsx';
import ProjectsView from './ProjectsView.jsx';
import RunPage from './RunPage.jsx';
import RunView from './RunView.jsx';
import SchedulesView from './SchedulesView.jsx';
import TopBar from './TopBar.jsx';
import { api } from './api.js';
import { Button, Field, Modal } from './ui.jsx';

// Shell: owns only what every view needs (the API token, server health, which
// view is open). Each view owns its own data and fetches it when it mounts.
//
// The URL is what picks the view (US-030): a run has to be linkable, and once
// there is a router the other views may as well have addresses too.
export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem('qassist_token') || localStorage.getItem('qagent_token') || ''
  );
  const [health, setHealth] = useState(null);
  // Dark unless the user says otherwise — a light OS should not decide what
  // the console looks like. 'system' is the opt-in that hands that back.
  const [theme, setTheme] = useState(() => localStorage.getItem('qassist_theme') || 'dark');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mirrored up from RunView so the header can show it from either view.
  const [runState, setRunState] = useState({ status: 'idle', wsState: 'idle', runId: null });
  // The signed-in user in multi-user mode (US-021): undefined while we check the
  // session cookie, null when logged out, the user object once resolved. Stays
  // null forever in token/open mode — there is no user concept there.
  const [me, setMe] = useState(undefined);

  useEffect(() => {
    localStorage.setItem('qassist_token', token);
  }, [token]);

  // 'system' is resolved to a concrete dark/light here rather than in CSS, so
  // the light palette is written once (`:root[data-theme='light']`) instead of
  // once per selector. Dark leaves the attribute off: the tokens in `:root`
  // are already the dark theme, so the default costs nothing.
  useEffect(() => {
    localStorage.setItem('qassist_theme', theme);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    // Only worth watching while following the system — otherwise the choice
    // is fixed and the OS flipping at sunset is none of our business.
    if (theme !== 'system') return undefined;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

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

  const multi = health?.auth_mode === 'multi';

  // In multi-user mode the credential is the HTTP-only session cookie, resolved
  // by asking /api/auth/me who the browser is. A 401 (or any failure) means no
  // session — show the login screen. Skipped entirely outside multi mode.
  useEffect(() => {
    if (health == null) return undefined;
    if (!multi) {
      setMe(null);
      return undefined;
    }
    let cancelled = false;
    api('/api/auth/me')
      .then((u) => !cancelled && setMe(u))
      .catch(() => !cancelled && setMe(null));
    return () => {
      cancelled = true;
    };
  }, [health, multi]);

  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
  }

  const location = useLocation();

  // The token is a deployment detail, not part of running a test, so it lives
  // behind the gear rather than in the run form. In multi mode the session
  // cookie is the credential, so no token is ever needed here.
  const needsToken = !multi && (!health || health.auth) && !token;

  const atRun = location.pathname === '/';

  // Multi mode gates the whole app on a session: hold the render until /me
  // resolves, then show the login screen when there is no user. Token/open
  // mode never sets `multi`, so this is dead weight there and the app renders
  // exactly as before.
  if (multi && me === undefined) return null;
  if (multi && me === null) {
    return <Login invalid={new URLSearchParams(location.search).get('auth') === 'invalid'} />;
  }

  return (
    <>
      <TopBar
        showNav={!!health?.db}
        runState={runState}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="app">
        {/* Run sits outside <Routes> and only hides: unmounting would drop the
            live WebSocket and the finished run's result. The routed views are
            cheap to remount, and remounting is what refreshes them — History
            in particular should show the run you just watched finish. */}
        <div hidden={!atRun}>
          <RunView
            token={token}
            health={health}
            visible={atRun}
            needsToken={needsToken}
            onOpenSettings={() => setSettingsOpen(true)}
            onRunState={setRunState}
          />
        </div>
        <Routes>
          <Route path="/history" element={<HistoryView token={token} />} />
          <Route path="/schedules" element={<SchedulesView token={token} />} />
          <Route path="/projects" element={<ProjectsView token={token} health={health} />} />
          <Route
            path="/runs/:id"
            element={
              <RunPage
                token={token}
                needsToken={needsToken}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            }
          />
          {/* '/' is the Run view above, so it renders nothing extra here — but
              it needs its own route, or the catch-all below would match it and
              redirect the app to itself forever. */}
          <Route path="/" element={null} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      {settingsOpen && (
        <Modal
          title="Settings"
          description="Stored in this browser only — nothing is sent anywhere but your worker."
          onClose={() => setSettingsOpen(false)}
          footer={<Button variant="primary" onClick={() => setSettingsOpen(false)}>Done</Button>}
        >
          {multi ? (
            <Field label="Account" hint="Your session is a sign-in cookie, not a token.">
              <div className="settings-account">
                <span>{me?.email}</span>
                <Button variant="secondary" size="sm" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            </Field>
          ) : (
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
          )}
          <Field label="Theme" hint="Dark is the default. Match system follows your OS setting.">
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match system</option>
            </select>
          </Field>
          {health && (
            <dl className="detail-facts">
              <dt>Agent</dt>
              <dd>{health.agent_ready ? 'Ready' : 'No OPENAI_API_KEY on the server'}</dd>
              <dt>Control plane</dt>
              <dd>{health.db ? 'Connected' : 'Not configured — saved tests and history are off'}</dd>
              <dt>Auth</dt>
              <dd>
                {multi
                  ? 'Multi-user (magic-link)'
                  : health.auth
                    ? 'Token required'
                    : 'Open (no token configured)'}
              </dd>
              <dt>Email</dt>
              <dd>{health.mail ? 'Configured' : 'Off — no RESEND_API_KEY / MAIL_FROM'}</dd>
            </dl>
          )}
        </Modal>
      )}
    </>
  );
}
