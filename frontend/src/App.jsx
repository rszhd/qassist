import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import SavedTests from './SavedTests.jsx';

const STATUS_COLORS = {
  queued: '#a16207',
  running: '#2563eb',
  passed: '#16a34a',
  failed: '#dc2626',
  error: '#dc2626',
  completed: '#4b5563',
  idle: '#6b7280',
};

export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem('qassist_token') || localStorage.getItem('qagent_token') || ''
  );
  const [goal, setGoal] = useState('Verify the page loads and find the main heading text');
  const [startUrl, setStartUrl] = useState('https://news.ycombinator.com');
  const [status, setStatus] = useState('idle');
  const [wsState, setWsState] = useState('idle');
  const [runId, setRunId] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [currentAction, setCurrentAction] = useState(null);
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [health, setHealth] = useState(null);
  const [tests, setTests] = useState([]);
  const [activeTestId, setActiveTestId] = useState(null);
  // null = plain ad-hoc form. Otherwise the form doubles as the test editor:
  // `{ name }` creates, `{ id, name }` updates that row.
  const [editing, setEditing] = useState(null);
  const [savingTest, setSavingTest] = useState(false);
  const wsRef = useRef(null);
  const logRef = useRef(null);

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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps]);

  const loadTests = useCallback(async () => {
    if (!health?.db) return;
    try {
      const { tests: rows } = await api('/api/tests', { token });
      setTests(rows);
    } catch (err) {
      setError(`Saved tests: ${err.message}`);
    }
  }, [health?.db, token]);

  useEffect(() => {
    loadTests();
  }, [loadTests]);

  function handleEvent(evt) {
    switch (evt.type) {
      case 'status':
        setStatus(evt.status);
        if (evt.status === 'running') setCurrentAction('Launching browser and loading the page…');
        break;
      case 'start':
        setCurrentAction('Launching browser and loading the page…');
        break;
      case 'frame':
        // Continuous CDP screencast (JPEG) — this is the live video feed.
        if (evt.data) setScreenshot(`data:image/jpeg;base64,${evt.data}`);
        break;
      case 'step':
        setCurrentAction(evt.next_goal || evt.thinking || evt.evaluation || 'Thinking…');
        setSteps((s) => [...s, evt]);
        break;
      case 'progress':
        // Long-running tool activity (e.g. waiting for a confirmation email).
        setCurrentAction(evt.message);
        setSteps((s) => [...s, evt]);
        break;
      case 'done':
        setResult(evt);
        setCurrentAction(null);
        setStatus(evt.success === true ? 'passed' : evt.success === false ? 'failed' : 'completed');
        break;
      case 'error':
        setError(evt.message);
        setCurrentAction(null);
        setStatus('error');
        break;
      case 'end':
        setCurrentAction(null);
        setStatus((cur) => (cur === 'running' || cur === 'queued' ? evt.status : cur));
        break;
      default:
        break;
    }
  }

  function resetRunState() {
    setError(null);
    setResult(null);
    setSteps([]);
    setScreenshot(null);
    setCurrentAction(null);
    setStatus('queued');
  }

  // The form is shared, so Enter means "save" while the editor is open.
  async function startRun(e) {
    e.preventDefault();
    if (editing) return saveTest();
    resetRunState();
    setActiveTestId(null);
    try {
      const { runId: id } = await api('/api/runs', {
        token,
        method: 'POST',
        body: { goal, start_url: startUrl },
      });
      setRunId(id);
      openSocket(id);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  // Create or update from whatever the form currently holds. max_steps/model
  // aren't in the form, and PUT is a partial update, so they keep their value.
  async function saveTest() {
    const name = (editing?.name || '').trim();
    if (!name) return;
    setSavingTest(true);
    try {
      const body = { name, goal, start_url: startUrl };
      if (editing.id) await api(`/api/tests/${editing.id}`, { token, method: 'PUT', body });
      else await api('/api/tests', { token, method: 'POST', body });
      setEditing(null);
      await loadTests();
    } catch (err) {
      setError(`Save: ${err.message}`);
    } finally {
      setSavingTest(false);
    }
  }

  function editTest(test) {
    setError(null);
    setEditing({ id: test.id, name: test.name });
    setGoal(test.goal);
    setStartUrl(test.start_url);
  }

  async function deleteTest(test) {
    if (!window.confirm(`Delete "${test.name}"?`)) return;
    try {
      await api(`/api/tests/${test.id}`, { token, method: 'DELETE' });
      if (editing?.id === test.id) setEditing(null);
      if (activeTestId === test.id) setActiveTestId(null);
      await loadTests();
    } catch (err) {
      setError(`Delete: ${err.message}`);
    }
  }

  // One-click re-run: the server reads goal/URL off the saved row, so we only
  // mirror them into the form to show what's running.
  async function runSavedTest(test) {
    resetRunState();
    setActiveTestId(test.id);
    setGoal(test.goal);
    setStartUrl(test.start_url);
    try {
      const { runId: id } = await api(`/api/tests/${test.id}/run`, {
        token,
        method: 'POST',
        body: { trigger: 'ui' },
      });
      setRunId(id);
      openSocket(id);
    } catch (err) {
      setError(err.message);
      setStatus('error');
      setActiveTestId(null);
    }
  }

  function openSocket(id) {
    if (wsRef.current) wsRef.current.close();
    setWsState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws?runId=${id}&token=${encodeURIComponent(token)}`
    );
    ws.onopen = () => setWsState('live');
    ws.onclose = () => setWsState('closed');
    ws.onerror = () => {
      setWsState('error');
      setError('WebSocket could not connect — check the token and that the tunnel/port is reachable.');
    };
    ws.onmessage = (m) => {
      try {
        handleEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    wsRef.current = ws;
  }

  const [reportBusy, setReportBusy] = useState(false);

  async function downloadReport() {
    if (!runId) return;
    setReportBusy(true);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      // Report renders right after the run finishes; retry a few times on 202.
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`/api/runs/${runId}/report.pdf`, { headers });
        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        window.open(URL.createObjectURL(blob), '_blank');
        return;
      }
      throw new Error('report still generating — try again in a moment');
    } catch (err) {
      setError(`Report: ${err.message}`);
    } finally {
      setReportBusy(false);
    }
  }

  const running = status === 'running' || status === 'queued';
  const waitingForFirstFrame = running && !screenshot;
  // Keep the field until health says auth is off — and always if a token is
  // already stored, so it can be cleared.
  const showToken = !health || health.auth || !!token;

  return (
    <div className="app">
      <header>
        <h1>QAssist <span className="tag">prototype</span></h1>
        {runId && (
          <span className={`ws ws-${wsState}`}>
            ● {wsState === 'live' ? 'live' : wsState}
          </span>
        )}
        <span className="badge" style={{ background: STATUS_COLORS[status] || '#6b7280' }}>
          {status}
        </span>
      </header>

      <div className="layout">
        <section className="panel controls">
          {health && !health.agent_ready && (
            <div className="banner">
              <strong>Setup needed</strong>
              <span>
                No <code>OPENAI_API_KEY</code> on the server — runs will be rejected. Add it to{' '}
                <code>.env</code> and restart.
              </span>
            </div>
          )}

          {health?.db && (
            <SavedTests
              tests={tests}
              activeTestId={activeTestId}
              editingId={editing?.id || null}
              running={running}
              onRun={runSavedTest}
              onEdit={editTest}
              onDelete={deleteTest}
            />
          )}

          <form onSubmit={startRun}>
            {showToken && (
              <label>
                API token
                <input
                  type="password"
                  value={token}
                  placeholder="WORKER_API_TOKEN"
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
            )}
            {editing && (
              <label>
                Test name
                <input
                  value={editing.name}
                  autoFocus
                  placeholder="Checkout flow works"
                  onChange={(e) => setEditing((cur) => ({ ...cur, name: e.target.value }))}
                />
              </label>
            )}
            <label>
              Start URL
              <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} />
            </label>
            <label>
              Goal
              <textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
            </label>
            {editing ? (
              <div className="btn-row">
                <button type="submit" disabled={savingTest || !editing.name.trim()}>
                  {savingTest ? 'Saving…' : editing.id ? 'Save changes' : 'Save test'}
                </button>
                <button type="button" className="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="btn-row">
                <button type="submit" disabled={running}>
                  {running ? 'Running…' : 'Run test'}
                </button>
                {health?.db && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setEditing({ name: '' })}
                    disabled={!goal.trim() || !startUrl.trim()}
                  >
                    Save as test
                  </button>
                )}
              </div>
            )}
          </form>

          <p className="hint">
            Tip: some sites (Reddit, Cloudflare-protected pages) block datacenter IPs and will
            fail from a server. Try your own app, example.com, or Hacker News.
          </p>

          {error && <div className="error">⚠ {error}</div>}

          {result && (
            <div className={`result ${result.success ? 'ok' : 'bad'}`}>
              <div className="result-head">
                {result.success ? '✓ PASSED' : result.success === false ? '✗ FAILED' : '• DONE'}
              </div>
              <dl>
                <dt>Steps</dt><dd>{result.steps}</dd>
                <dt>Duration</dt><dd>{result.duration_seconds ? `${Math.round(result.duration_seconds)}s` : '—'}</dd>
              </dl>
              {result.final_result && <p className="final">{result.final_result}</p>}
              {result.errors?.length > 0 && (
                <ul className="errs">{result.errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
              )}
              <button type="button" className="report-btn" onClick={downloadReport} disabled={reportBusy}>
                {reportBusy ? 'Preparing PDF…' : '⭳ Download PDF report'}
              </button>
            </div>
          )}
        </section>

        <section className="panel viewer">
          <div className="screen">
            {screenshot ? (
              <img src={screenshot} alt="live browser view" />
            ) : waitingForFirstFrame ? (
              <div className="thinking">
                <div className="spinner" />
                <div>Agent is starting…</div>
                <small>First frame appears after the first action (~10–15s)</small>
              </div>
            ) : (
              <div className="placeholder">Live browser view will appear here</div>
            )}
          </div>
          {currentAction && (
            <div className="action-bar">
              <span className="pulse" /> {currentAction}
            </div>
          )}
          <div className="log" ref={logRef}>
            {steps.map((s, i) =>
              s.type === 'progress' ? (
                <div className="log-item progress" key={i}>
                  <span className="step-n">✉</span>
                  <span className="step-goal">{s.message}</span>
                </div>
              ) : (
                <div className="log-item" key={i}>
                  <span className="step-n">#{s.step}</span>
                  <span className="step-goal">{s.next_goal || s.thinking || s.evaluation || '…'}</span>
                  {s.url && <span className="step-url">{s.url}</span>}
                </div>
              )
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
