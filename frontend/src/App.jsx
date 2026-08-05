import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import ApiKeys from './ApiKeys.jsx';
import Billing from './Billing.jsx';
import OpenaiKey from './OpenaiKey.jsx';
import DemoBanner from './DemoBanner.jsx';
import HistoryView from './HistoryView.jsx';
import Login from './Login.jsx';
import Onboarding from './Onboarding.jsx';
import ProjectsView from './ProjectsView.jsx';
import RunPage from './RunPage.jsx';
import RunView from './RunView.jsx';
import SchedulesView from './SchedulesView.jsx';
import TopBar from './TopBar.jsx';
import { api } from './api.js';
import { Button, Field, Modal } from './ui.jsx';

// The user manual (US-070). Absolute and the same on every instance, including
// a self-hosted one: it is published off `dev` rather than built into the
// image, so a per-instance copy would be as old as the release it shipped with.
const MANUAL_URL = 'https://docs.qassist.run';

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
  // false, or the open dialog — `true` from the gear, a field name from a
  // banner that is asking for that one thing, which the dialog then opens on.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = (field) => setSettingsOpen(field || true);
  // Mirrored up from RunView so the header can show it from either view.
  const [runState, setRunState] = useState({ status: 'idle', wsState: 'idle', runId: null });
  // The signed-in user in multi-user mode (US-021): undefined while we check the
  // session cookie, null when logged out, the user object once resolved. Stays
  // null forever in token/open mode — there is no user concept there.
  const [me, setMe] = useState(undefined);
  // US-036 demo sandbox: null until the on-mount bootstrap resolves, then
  // { expiresAt } once a tenant is provisioned (or recognised from the cookie),
  // or { error } when the deployment is at capacity / rate-limited. Only ever
  // set in demo mode.
  const [demoSession, setDemoSession] = useState(null);

  useEffect(() => {
    localStorage.setItem('qassist_token', token);
  }, [token]);

  // /api/health is unauthenticated — it tells us whether a token is even
  // needed (auth) and whether the control plane is up (db).
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
  const demo = health?.auth_mode === 'demo';

  // Whether the caller has an OpenAI key stored (US-039): runs are funded by
  // it, so the Run view's "setup needed" banner keys off this — health can't
  // say it, readiness is per-user now. Null until known (or unknowable: a demo
  // runs no agent, a missing token can't ask), so the banner never flashes on
  // a guess. Reloaded after every change in the Settings key field.
  const [keyStatus, setKeyStatus] = useState(null);
  const loadKeyStatus = () =>
    api('/api/account/openai-key', { token })
      .then(setKeyStatus)
      .catch(() => setKeyStatus(null));
  useEffect(() => {
    if (!health || demo) return;
    if (multi && !me) return;
    loadKeyStatus();
  }, [health, demo, multi, me, token]);

  // Subscription state (US-053): owned here rather than by the Settings panel,
  // because the onboarding wall and the panel must agree about one account and
  // only one of them can own the fetch. Never asked on a self-hosted instance —
  // `health.billing` false means no request at all, which is the free tier's
  // proof on the wire.
  const [billingStatus, setBillingStatus] = useState(null);
  const loadBillingStatus = () =>
    api('/api/billing/status')
      .then(setBillingStatus)
      .catch(() => setBillingStatus(null));
  useEffect(() => {
    if (!health?.billing || !me) return;
    loadBillingStatus();
  }, [health, me]);

  // In demo mode the very first request from a cookieless visitor mints a seeded
  // tenant and drops the session cookie every later API/WS call authenticates
  // with. So the app render is held (below) until this resolves — otherwise the
  // views would mount and fetch before the cookie exists and 401.
  useEffect(() => {
    if (!demo) return undefined;
    let cancelled = false;
    api('/api/demo/session', { method: 'POST' })
      .then((s) => !cancelled && setDemoSession({ expiresAt: s.expiresAt }))
      .catch((err) => !cancelled && setDemoSession({ error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [demo]);

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

  // Every gate below is derived from `health`, and an unresolved `health` makes
  // each of them read as its *unauthenticated* branch: no multi, no demo, no
  // wall. So rendering before it answers paints the whole app — Run view and
  // all — over whatever the deployment actually shows a stranger, and takes it
  // away again a round trip later. Hold instead.
  if (health == null) return null;

  // The token is a deployment detail, not part of running a test, so it lives
  // behind the gear rather than in the run form. Both cookie modes are exempt:
  // in multi the session cookie is the credential, and in demo it's the
  // visitor's sandbox cookie. `health.auth` only reports that WORKER_API_TOKEN
  // is *set*, and a demo deployment sets one it never consults (makeGate takes
  // the cookie branch first), so without `!demo` the demo blocks every visitor
  // behind a token none of them can have.
  const needsToken = !multi && !demo && health.auth && !token;

  const atRun = location.pathname === '/';

  // Multi mode gates the whole app on a session: hold the render until /me
  // resolves, then show the login screen when there is no user. Token/open
  // mode never sets `multi`, so this is dead weight there and the app renders
  // exactly as before.
  if (multi && me === undefined) return null;
  if (multi && me === null) {
    return <Login invalid={new URLSearchParams(location.search).get('auth') === 'invalid'} />;
  }
  // Hold the demo app until the tenant is provisioned and its cookie set, so the
  // views don't fetch before they're authenticated. A capacity error still
  // resolves demoSession (to `{ error }`), so this doesn't hang the app.
  if (demo && demoSession === null) return null;

  // Forced onboarding (US-053), on billing instances only: an account that has
  // never paid gets the checklist instead of the app, since every run it could
  // start would be refused anyway. Held until both statuses have answered, so
  // the app is never shown behind a wall that then drops over it. A key removed
  // later is the Run view's banner to raise, not grounds to lock someone out of
  // their own history.
  //
  // US-054 amends US-053's "entitlement alone raises it" by exactly one
  // condition: an account that has paid but has no capacity yet is still behind
  // the wall, on a fourth step. `activation_pending` is absent on every instance
  // without an activation window — and on every server that predates one — so
  // this reads as the pre-US-054 condition there.
  if (multi && health.billing) {
    if (!billingStatus || !keyStatus) return null;
    const walled = !billingStatus.entitled || billingStatus.activation_pending;
    if (walled) {
      return (
        <Onboarding
          email={me?.email}
          token={token}
          keyStatus={keyStatus}
          onReloadKey={loadKeyStatus}
          billing={billingStatus}
          onReloadBilling={loadBillingStatus}
          onSignOut={signOut}
        />
      );
    }
  }

  return (
    <>
      <TopBar
        showNav={!!health?.db}
        runState={runState}
        onOpenSettings={openSettings}
      />
      {demo && (
        <DemoBanner
          expiresAt={demoSession?.expiresAt}
          ctaUrl={health?.cta_url}
          error={demoSession?.error}
        />
      )}
      <div className="app">
        {/* Run sits outside <Routes> and only hides: unmounting would drop the
            live WebSocket and the finished run's result. The routed views are
            cheap to remount, and remounting is what refreshes them — History
            in particular should show the run you just watched finish. */}
        <div className="run-shell" hidden={!atRun}>
          <RunView
            token={token}
            health={health}
            keyStatus={keyStatus}
            visible={atRun}
            needsToken={needsToken}
            onOpenSettings={openSettings}
            onRunState={setRunState}
          />
        </div>
        <Routes>
          <Route path="/history" element={<HistoryView token={token} />} />
          <Route path="/schedules" element={<SchedulesView token={token} />} />
          {/* One route with both segments optional, not three routes sharing an
              element: switching project or section then changes params on the
              same match instead of remounting the view and refetching it. */}
          <Route
            path="/projects/:slug?/:tab?"
            element={<ProjectsView token={token} health={health} />}
          />
          <Route
            path="/runs/:id"
            element={
              <RunPage
                token={token}
                health={health}
                needsToken={needsToken}
                onOpenSettings={openSettings}
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
          footer={
            <>
              <Button
                as="a"
                variant="ghost"
                icon={BookOpen}
                className="foot-link"
                href={MANUAL_URL}
                target="_blank"
                rel="noreferrer"
              >
                Manual
              </Button>
              <Button variant="primary" onClick={() => setSettingsOpen(false)}>Done</Button>
            </>
          }
        >
          <div className="settings">
            {multi && (
              <>
                <Field label="Account" hint="Your session is a sign-in cookie, not a token.">
                  <div className="settings-account">
                    <span>{me?.email}</span>
                    <Button variant="secondary" size="sm" onClick={signOut}>
                      Sign out
                    </Button>
                  </div>
                </Field>
                {/* US-022: only when the instance actually bills. Unset STRIPE_*
                    leaves health.billing false and the dialog is what it was. */}
                {health?.billing && <Billing state={billingStatus} keyStatus={keyStatus} />}
                <ApiKeys />
              </>
            )}
            {/* Both cookie modes hide this: the field asks for the deployment's
                WORKER_API_TOKEN, which a demo visitor can't have and doesn't need. */}
            {!multi && !demo && (
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
            {/* Every mode with an agent (US-039): runs are funded by the caller's
                stored key, in a solo self-host exactly like a tenant. A demo runs
                no agent, so it has no key to manage. */}
            {!demo && (
              <OpenaiKey
                token={token}
                status={keyStatus}
                onReload={loadKeyStatus}
                autoFocus={settingsOpen === 'openai-key'}
              />
            )}
            {health && (
              <div className="settings-instance">
                <div className="field-label">Instance</div>
                <dl className="detail-facts">
                  <dt>Control plane</dt>
                  <dd>{health.db ? 'Connected' : 'Not configured — saved tests and history are off'}</dd>
                  <dt>Auth</dt>
                  <dd>
                    {multi
                      ? 'Multi-user (magic-link)'
                      : demo
                        ? 'Demo sandbox (session cookie)'
                        : health.auth
                          ? 'Token required'
                          : 'Open (no token configured)'}
                  </dd>
                  <dt>Email</dt>
                  <dd>{health.mail ? 'Configured' : 'Off — no RESEND_API_KEY / MAIL_FROM'}</dd>
                  {/* Absent rather than "Off" (US-022): on a free instance billing
                      isn't a setting that happens to be disabled, it doesn't exist. */}
                  {health.billing && (
                    <>
                      <dt>Billing</dt>
                      <dd>Stripe — runs need a subscription</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
