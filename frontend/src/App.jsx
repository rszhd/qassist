import { useEffect, useRef, useState } from 'react';

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
  const [token, setToken] = useState(() => localStorage.getItem('qagent_token') || '');
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
  const wsRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('qagent_token', token);
  }, [token]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps]);

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

  async function startRun(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setSteps([]);
    setScreenshot(null);
    setCurrentAction(null);
    setStatus('queued');
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ goal, start_url: startUrl }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const { runId: id } = await res.json();
      setRunId(id);
      openSocket(id);
    } catch (err) {
      setError(err.message);
      setStatus('error');
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

  return (
    <div className="app">
      <header>
        <h1>QAgent <span className="tag">prototype</span></h1>
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
          <form onSubmit={startRun}>
            <label>
              API token
              <input
                type="password"
                value={token}
                placeholder="WORKER_API_TOKEN"
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <label>
              Start URL
              <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} />
            </label>
            <label>
              Goal
              <textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
            </label>
            <button type="submit" disabled={running}>
              {running ? 'Running…' : 'Run test'}
            </button>
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
            {steps.map((s) => (
              <div className="log-item" key={s.step}>
                <span className="step-n">#{s.step}</span>
                <span className="step-goal">{s.next_goal || s.thinking || s.evaluation || '…'}</span>
                {s.url && <span className="step-url">{s.url}</span>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
